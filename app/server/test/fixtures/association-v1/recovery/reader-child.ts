/**
 * A gateless READER child, for the parked-mid-rebuild evidence case (#67).
 *
 * The materializer holds the writer gate while it is parked, so the read that
 * has to stay complete cannot come from that process — it has to come from a
 * separate one that never takes the gate. `openEvidenceReader` needs none.
 *
 * Prints exactly one JSON line: the read result, or the error envelope with
 * the real class name attached.
 *
 * argv: <plan.json>
 */

export {};

const plan = JSON.parse(await Bun.file(process.argv[2]!).text());
const { openEvidenceReader } = await import(plan.serviceModule);

const reader = await openEvidenceReader(plan.datasetRoot);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

try {
  const value = await reader.evidence.getRevisionAssociations(encode(plan.request));
  await Bun.write(Bun.stdout, `${JSON.stringify({ ok: true, value: value ?? null })}\n`);
} catch (error: any) {
  const failure =
    typeof error?.toJSON === "function"
      ? { ...error.toJSON(), name: error.name }
      : { version: null, code: null, path: null, name: error?.name ?? null, message: String(error?.message ?? error) };
  await Bun.write(Bun.stdout, `${JSON.stringify({ ok: false, error: failure })}\n`);
}
