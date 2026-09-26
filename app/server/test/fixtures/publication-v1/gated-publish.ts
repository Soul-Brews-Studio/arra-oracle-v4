// Owned fault-test child. Runs INSIDE the writer gate (exec'd by the Python
// launcher), publishes one revision, and prints JSON to stdout.
//
// Lives under test fixtures on purpose: it is not a runtime worker and not a
// CLI surface. ARRA_PUB_* are test-harness inputs, never product config.
import { readArgPayload } from "../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  request: unknown;
  revisionIds: string[];
  clockMs: number;
  parkAt?: string;
};

const { openPublicationWriter } = await import(
  new URL("../../../src/publication/service.ts", import.meta.url).pathname
);

let index = 0;
const service = await openPublicationWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[index++] ?? `fallback${String(index).padStart(15, "0")}`,
  clock: () => payload.clockMs,
  onBoundary: payload.parkAt
    ? async (boundary: string) => {
        if (boundary !== payload.parkAt) return;
        // Tell the parent we reached the commanded boundary, then park. The
        // PARENT owns the deadline and the kill; this child never self-times.
        console.log(JSON.stringify({ boundary }));
        await new Promise(() => {});
      }
    : undefined,
});

try {
  const outcome = await service.publishRevision(
    new TextEncoder().encode(JSON.stringify(payload.request)),
  );
  console.log(JSON.stringify({ ok: true, outcome }));
} catch (error) {
  const e = error as { code?: string; path?: string; message?: string; stack?: string };
  console.log(JSON.stringify({
    ok: false, code: e.code ?? null, path: e.path ?? null,
    // Diagnostic only, and only in this owned fault-test child.
    ...(process.env.ARRA_PUB_DEBUG ? { stack: (e.stack ?? "").split("\n").slice(0, 6).join(" | ") } : {}),
  }));
} finally {
  await service.close();
}
