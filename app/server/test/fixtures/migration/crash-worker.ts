// Owned test child for the #34 copy migration's crash lane.
//
// Launched in place of the real worker entry (the Python test swaps `--bun`
// for a wrapper that execs this file with the plan path), so it runs under the
// orchestrator's held writer gate as fd 42 exactly like the real worker. It
// drives the REAL `runMigrationWorker` and SIGKILLs itself from the kernel's
// own `after_revision_append` boundary on the third publish: a revision row is
// appended and its head is not yet published. No timer, no race.
const [, , planPath] = Bun.argv;
if (!planPath) {
  console.error("usage: crash-worker.ts <plan.json>");
  process.exit(2);
}

const { runMigrationWorker } = await import(
  new URL("../../../src/migration/runMigrationWorker.ts", import.meta.url).pathname
);

let appended = 0;
await runMigrationWorker(planPath, process.env, () => {}, {
  onBoundary: async (boundary: string) => {
    if (boundary === "after_revision_append" && ++appended === 3) process.kill(process.pid, "SIGKILL");
  },
});
// Reaching here means the crash point never fired: the lane proved nothing.
console.error("crash point not reached");
process.exit(3);
