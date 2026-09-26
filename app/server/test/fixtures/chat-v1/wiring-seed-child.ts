// Owned seed child for `chat-production-wiring.test.ts` (#32, ruling R9).
//
// Runs INSIDE the writer gate and seeds two workspaces with evidence the
// parent then reads through the production composition. Three kinds of text,
// each marked so the parent can search a model prompt for it:
//
//   PRIVATE-A  alpha, session `main` (peer-a is a member): the one piece of
//              evidence peer-a's answer may use;
//   SECRET-A   alpha, session `secret-session`, linked FROM `main`, joined
//              only by peer-b: another session's secret;
//   PRIVATE-B  beta, same session and peer names as alpha: another
//              workspace's data.
//
// No model is involved here; this child only writes.
const [, , datasetRoot] = Bun.argv;

const { openContextWriter } = await import(new URL("../../../src/publication/service.ts", import.meta.url).pathname);

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

let now = Date.parse("2026-09-26T12:00:00.000Z");
const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => "unusedunusedunused000",
  clock: () => now,
  sourceNamespace: null,
});
const call = (method: string, request: unknown) =>
  (service.context as Record<string, (b: Uint8Array) => Promise<unknown>>)[method]!(enc(request));

const out: Record<string, unknown> = {};
try {
  for (const ws of ["alpha-workspace", "beta-workspace"]) {
    const tag = ws === "alpha-workspace" ? "a" : "b";
    await call("registerPeer", { workspace_name: ws, peer_id: pad(`peera${tag}`), name: "peer-a" });
    await call("registerPeer", { workspace_name: ws, peer_id: pad(`peerb${tag}`), name: "peer-b" });
    await call("registerSession", { workspace_name: ws, session_id: pad(`main${tag}`), name: "main" });
    await call("joinSession", { workspace_name: ws, session_name: "main", peer_name: "peer-a" });
  }
  const WS = "alpha-workspace";
  await call("registerSession", { workspace_name: WS, session_id: pad("secreta"), name: "secret-session" });
  await call("joinSession", { workspace_name: WS, session_name: "secret-session", peer_name: "peer-b" });
  await call("createSessionLink", {
    id: pad("wirelink1"),
    workspace_name: WS,
    from_session_name: "main",
    to_session_name: "secret-session",
    relation: "related_to",
    evidence_ref: null,
    created_by_peer_name: null,
  });
  const message = (ws: string, session: string, peer: string, id: string, content: string) => {
    now += 1000;
    return call("appendMessages", {
      workspace_name: ws,
      session_name: session,
      items: [{ public_id: pad(id), message: { peer_name: peer, role: null, content, in_reply_to: null }, source: null }],
    });
  };
  await message(WS, "main", "peer-a", "wirea1", "PRIVATE-A the deploy moved to Thursday");
  await message(WS, "secret-session", "peer-b", "wiresecret1", "SECRET-A the vault passphrase is swordfish");
  await message("beta-workspace", "main", "peer-a", "wireb1", "PRIVATE-B beta workspace roadmap");
  out.ok = true;
} catch (error) {
  const e = error as { name?: string; code?: string; path?: string; message?: string };
  out.error = { name: e?.name, code: e?.code, path: e?.path, message: String(e?.message ?? e) };
} finally {
  await service.close().catch(() => undefined);
}
console.log(JSON.stringify(out));
