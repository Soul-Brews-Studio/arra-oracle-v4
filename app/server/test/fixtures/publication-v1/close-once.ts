// Owned fault-test child for one-shot writer close.
//
// close() releases the INHERITED gate descriptor (fd 42). A descriptor number
// is a reusable integer, not an identity: once fd 42 is closed the kernel is
// free to hand 42 back for something else entirely, so a close() that releases
// on every call will eventually close a descriptor it never owned.
//
// Scenarios:
//   "reuse"      - the defect above, proven by taking fd 42 back for a
//                  harmless scratch file and asking whether it survived.
//   "concurrent" - repeated close must return ONE promise, drain ONCE, and
//                  leave in-flight completion, queued rejection and
//                  read-after-close behaviour exactly as they were.
//
// Sequencing uses the service's own `before_append` boundary, never a timer.
// A sleep proves nothing here: it can elapse after the publication already
// finished, so "in flight" would be asserted about an operation that was over.
// Parking ON the boundary makes the operation demonstrably begun and
// demonstrably not yet finished for as long as the park is held.
import { closeSync, fstatSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readArgPayload } from "../../helpers/argv.readArgPayload";

const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  scenario: "reuse" | "concurrent";
  request: unknown;
  queued?: unknown;
  revisionIds: string[];
  clockMs: number;
};

const { openPublicationWriter } = await import(
  new URL("../../../src/publication/service.ts", import.meta.url).pathname
);

const GATE_FD = Number(process.env.ARRA_WRITER_FD ?? "42");
const results: Record<string, unknown> = { gateFd: GATE_FD };

let signalEntered: () => void = () => {};
const entered = new Promise<void>((resolve) => {
  signalEntered = resolve;
});
let releasePark: () => void = () => {};
const parked = new Promise<void>((resolve) => {
  releasePark = resolve;
});
let parkedOnce = false;

let index = 0;
const service = await openPublicationWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[index++] ?? `fallback${String(index).padStart(15, "0")}`,
  clock: () => payload.clockMs,
  ...(payload.scenario === "concurrent"
    ? {
        onBoundary: async (boundary: string) => {
          if (boundary !== "before_append" || parkedOnce) return;
          parkedOnce = true;
          // Inside the queued turn, past validation, before any write.
          signalEntered();
          await parked;
        },
      }
    : {}),
});

const publish = async (label: string, request: unknown) => {
  try {
    results[label] = {
      ok: true,
      outcome: await service.publishRevision(new TextEncoder().encode(JSON.stringify(request))),
    };
  } catch (error) {
    const e = error as { code?: string };
    results[label] = { ok: false, code: e.code ?? null };
  }
};

/** Let every already-scheduled microtask run, without introducing a timer. */
const drainMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 64; i += 1) await Promise.resolve();
};

if (payload.scenario === "reuse") {
  // Scratch lives INSIDE the dataset root the parent fixture already owns and
  // removes, so a killed child cannot leak a directory somewhere else.
  const scratchPath = join(datasetRoot!, ".arra-close-once-scratch");
  const opened: number[] = [];
  let holding = -1;
  try {
    await publish("published", payload.request);
    await service.close();
    results.firstCloseReturned = true;

    // `open` returns the LOWEST free descriptor, so opening repeatedly walks
    // up through whatever is free until it hands back the number the gate used
    // to hold. Everything opened on the way is closed again.
    for (let i = 0; i < 256 && holding < 0; i += 1) {
      const fd = openSync(scratchPath, "w");
      if (fd === GATE_FD) holding = fd;
      else opened.push(fd);
    }
    results.seizedGateFd = holding === GATE_FD;

    if (holding !== GATE_FD) {
      // Never write to a descriptor we did not prove we own. Without the
      // seizure this scenario cannot say anything, so it stops here and the
      // parent assertion fails on seizedGateFd rather than on a guess.
      results.unrelatedFdStillOpen = null;
    } else {
      // Content of our own, so the survivor can be identified as THIS file.
      writeSync(holding, "not-the-gate");

      // The second close must be a no-op for the descriptor. Before the repair
      // it is not: it closes fd 42 again, and fd 42 is now this scratch file.
      await service.close();
      results.secondCloseReturned = true;

      try {
        const live = fstatSync(GATE_FD);
        const onDisk = statSync(scratchPath);
        results.unrelatedFdStillOpen = true;
        results.unrelatedFdIsOurFile = live.ino === onDisk.ino && live.dev === onDisk.dev;
      } catch (error) {
        results.unrelatedFdStillOpen = false;
        results.unrelatedFdCloseError = (error as { code?: string }).code ?? null;
        holding = -1; // already closed by the defect; do not double-close
      }
    }
  } finally {
    for (const fd of opened) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to release.
      }
    }
    if (holding >= 0) {
      try {
        closeSync(holding);
      } catch {
        // Nothing to release.
      }
    }
    rmSync(scratchPath, { force: true });
  }
} else {
  const inFlight = publish("published", payload.request);
  // Genuinely begun and genuinely unfinished: the operation is sitting on its
  // own boundary and cannot proceed until this child releases it.
  await entered;

  const first = service.close();
  const second = service.close();
  const third = service.close();
  // One cached promise, not three equivalent ones.
  results.closeIdentity = first === second && second === third;

  const settled = [false, false, false];
  void first.then(() => {
    settled[0] = true;
  });
  void second.then(() => {
    settled[1] = true;
  });
  void third.then(() => {
    settled[2] = true;
  });
  await drainMicrotasks();
  // close() drains; while the in-flight operation is parked it cannot finish.
  results.settledWhileParked = settled.some(Boolean);

  // Enqueued AFTER close: must be rejected, unchanged by the repair.
  const queued = publish("queuedAfterClose", payload.queued);

  releasePark();
  await Promise.all([first, second, third]);
  results.closeStatuses = ["fulfilled", "fulfilled", "fulfilled"];
  await inFlight;
  await queued;

  // Read after close: still refused by the released adapter, unchanged.
  try {
    await service.getAcceptedHead(
      new TextEncoder().encode(
        JSON.stringify({ workspace_name: "alpha-workspace", node_id: "a".repeat(21) }),
      ),
    );
    results.readAfterClose = { ok: true };
  } catch (error) {
    const e = error as { code?: string };
    results.readAfterClose = { ok: false, code: e.code ?? null };
  }

  // The gate really was released, exactly once.
  try {
    fstatSync(GATE_FD);
    results.gateFdStillOpen = true;
  } catch {
    results.gateFdStillOpen = false;
  }
}

console.log(JSON.stringify(results));
