// Owned seed child for `context-peer-representation.test.ts` (#32 / #31,
// Nat 2026-09-28 NAT-DECISIONS D3b). Runs INSIDE the real writer gate and
// seeds two workspaces with peers, sessions, messages and conclusion
// revisions the parent then reads through the reader and both transports.
//
// Marker text the parent searches for:
//   SECRET     anything only a member of `private` may see;
//   BETA-ONLY  another workspace's conclusion.
//   SIDE-SESSION-ONLY  a conclusion in a session neo belongs to but did not
//              request and that is not linked to `main` (verifier finding 1).
//   CHAINED-VIEW  a conclusion in a session linked from `main` (in scope).
//   LOCKED-VIEW   a conclusion in a session linked from `main` that neo may
//              not read (in scope, withheld: the coarse flag).
//   BETA-HIDDEN   beta's out-of-scope protected conclusion (must not flip
//              beta's coverage to partial -- verifier finding 2).
//   EXPIRED-VIEW / FUTURE-VIEW / INACTIVE-VIEW  outside the validity window
//              or inactive.
//
// No model is involved here; this child only writes.
const [, , datasetRoot] = Bun.argv;

const { openEvidenceWriter } = await import(new URL("../../../src/publication/service.ts", import.meta.url).pathname);

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

let now = Date.parse("2026-09-28T01:00:00.000Z");
let revisionCounter = 0;
const service = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => pad(`prrev${String(++revisionCounter).padStart(3, "0")}`),
  clock: () => (now += 1000),
  sourceNamespace: null,
});
type Facade = Record<string, (b: Uint8Array) => Promise<unknown>>;
const call = (facade: "context" | "publication" | "taxonomy", method: string, request: unknown) =>
  (service[facade] as Facade)[method]!(enc(request)) as Promise<Record<string, unknown>>;

const terms: Record<string, { vocabulary: string; conclusion: string; note: string }> = {};
const out: Record<string, unknown> = { revisions: {} as Record<string, string>, nodes: {} as Record<string, string> };

/** One revision of `type` term `kind`, links as given. */
function revision(ws: string, nodeId: string, kind: "conclusion" | "note", fields: Record<string, unknown>) {
  const t = terms[ws]!;
  return {
    workspace_name: ws,
    node_id: nodeId,
    base_revision_id: null,
    title: "a conclusion",
    body: "body",
    body_format: "text",
    fields: "{}",
    author_peer_name: null,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: null,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: null,
    schema_version: "1",
    canonical_version: "arra-revision/v1",
    term_snapshot_json: JSON.stringify([
      {
        label_snapshot: null,
        position: "0",
        term_id: kind === "conclusion" ? t.conclusion : t.note,
        term_name_snapshot: kind,
        vocabulary_id: t.vocabulary,
        vocabulary_name_snapshot: "type",
      },
    ]),
    link_snapshot_json: "[]",
    h_metadata: null,
    internal_metadata: null,
    ...fields,
  };
}

const messageLink = (session: string, publicId: string) =>
  JSON.stringify([
    {
      position: "0",
      relation: "supports",
      target_kind: "message",
      target: { session_name: session, message_public_id: publicId },
      excerpt: null,
      content_hash: null,
      captured_at: null,
      capture_status: "locator_only",
      note: null,
    },
  ]);

async function publish(label: string, ws: string, kind: "conclusion" | "note", fields: Record<string, unknown>) {
  // The trailing `x` keeps C1 and C10 apart after padding.
  const nodeId = pad(`prnode${label}x`);
  const result = await call("publication", "publishRevision", {
    operation_id: `pr-op-${label}`,
    content: revision(ws, nodeId, kind, fields),
  });
  (out.nodes as Record<string, string>)[label] = nodeId;
  (out.revisions as Record<string, string>)[label] = result.revision_id as string;
  return { nodeId, revisionId: result.revision_id as string };
}

try {
  for (const [ws, tag] of [["alpha-workspace", "a"], ["beta-workspace", "b"]] as const) {
    terms[ws] = { vocabulary: pad(`prtype${tag}`), conclusion: pad(`prconc${tag}`), note: pad(`prnote${tag}`) };
    await call("taxonomy", "seedReservedVocabularies", {
      workspace_name: ws,
      type: {
        vocabulary_id: terms[ws]!.vocabulary,
        terms: {
          note: terms[ws]!.note,
          conclusion: terms[ws]!.conclusion,
          learning: pad(`prlearn${tag}`),
          discussion: pad(`prdisc${tag}`),
          correction: pad(`prcorr${tag}`),
        },
      },
      memory_horizon: {
        vocabulary_id: pad(`prhoriz${tag}`),
        terms: { short_term: pad(`prshort${tag}`), long_term: pad(`prlong${tag}`) },
      },
    });
    for (const peer of ["neo", "nat", "claude", "outsider"]) {
      await call("context", "registerPeer", { workspace_name: ws, peer_id: pad(`pr${peer}${tag}`), name: peer });
    }
    await call("context", "registerSession", { workspace_name: ws, session_id: pad(`prmain${tag}`), name: "main" });
    await call("context", "joinSession", { workspace_name: ws, session_name: "main", peer_name: "neo" });
    await call("context", "joinSession", { workspace_name: ws, session_name: "main", peer_name: "nat" });
  }
  const WS = "alpha-workspace";
  await call("context", "registerSession", { workspace_name: WS, session_id: pad("prprivate"), name: "private" });
  await call("context", "joinSession", { workspace_name: WS, session_name: "private", peer_name: "claude" });
  const append = (ws: string, session: string, peer: string, id: string, content: string) =>
    call("context", "appendMessages", {
      workspace_name: ws,
      session_name: session,
      items: [{ public_id: pad(id), message: { peer_name: peer, role: null, content, in_reply_to: null }, source: null }],
    });
  await append(WS, "main", "nat", "prmsgmain", "nat: I drink black coffee every morning");
  await append(WS, "private", "claude", "prmsgsecret", "SECRET claude private note");
  await append("beta-workspace", "main", "nat", "prmsgbeta", "BETA-ONLY message");

  // C1: neo -> nat, Thai text, sourced from a message neo may read.
  await publish("C1", WS, "conclusion", {
    title: "นัทชอบกาแฟ",
    body: "นัทชอบกาแฟดำทุกเช้า (nat likes black coffee)",
    author_peer_name: "neo",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    link_snapshot_json: messageLink("main", pad("prmsgmain")),
  });
  // C2: claude -> nat, workspace-level (no session): any reader may see it.
  await publish("C2", WS, "conclusion", {
    body: "claude thinks nat prefers short answers",
    author_peer_name: "claude",
    observer_peer_name: "claude",
    subject_peer_name: "nat",
  });
  // C3: neo -> nat, but scoped to `private`, which neo is not a member of.
  await publish("C3", WS, "conclusion", {
    body: "SECRET conclusion drawn in the private session",
    author_peer_name: "claude",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    session_name: "private",
  });
  // C4 -> superseded by C5.
  const c4 = await publish("C4", WS, "conclusion", {
    body: "OLD-VIEW nat drinks tea",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
  });
  const c5 = await publish("C5", WS, "conclusion", {
    body: "NEW-VIEW nat switched from tea to coffee",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
  });
  await call("context", "supersedeNode", {
    workspace_name: WS,
    node_id: c4.nodeId,
    expected_revision_id: c4.revisionId,
    new_node_id: c5.nodeId,
    new_revision_id: c5.revisionId,
    reason: "corrected",
    peer_name: null,
    operation_id: "pr-op-supersede-c4",
  });
  // C6 -> retired.
  const c6 = await publish("C6", WS, "conclusion", {
    body: "RETIRED-VIEW nat is on holiday",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
  });
  await call("context", "retireNode", {
    workspace_name: WS,
    node_id: c6.nodeId,
    expected_revision_id: c6.revisionId,
    reason: "stale",
    peer_name: null,
    operation_id: "pr-op-retire-c6",
  });
  // C7: a note, not a conclusion.
  await publish("C7", WS, "note", {
    body: "NOTE-ONLY neo jotted this about nat",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
  });
  // C8: neo -> claude, sourced from a message in `private` (protected source).
  await publish("C8", WS, "conclusion", {
    body: "claude keeps private notes",
    observer_peer_name: "neo",
    subject_peer_name: "claude",
    link_snapshot_json: messageLink("private", pad("prmsgsecret")),
  });
  // Another workspace, same peer names.
  await publish("B1", "beta-workspace", "conclusion", {
    body: "BETA-ONLY neo thinks nat is in beta",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
  });

  // Verifier finding 1: `side` -- neo is a member, but it is neither the
  // requested session nor linked from `main`.
  await call("context", "registerSession", { workspace_name: WS, session_id: pad("prside"), name: "side" });
  await call("context", "joinSession", { workspace_name: WS, session_name: "side", peer_name: "neo" });
  await publish("C9", WS, "conclusion", {
    body: "SIDE-SESSION-ONLY neo noted nat in a side session",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    session_name: "side",
  });
  // In the chain: `chained` (neo is a member) and `locked` (claude only).
  let linkNo = 0;
  for (const [name, member] of [["chained", "neo"], ["locked", "claude"]] as const) {
    await call("context", "registerSession", { workspace_name: WS, session_id: pad(`pr${name}`), name });
    await call("context", "joinSession", { workspace_name: WS, session_name: name, peer_name: member });
    await call("context", "createSessionLink", {
      id: pad(`prlink${++linkNo}`),
      workspace_name: WS,
      from_session_name: "main",
      to_session_name: name,
      relation: "related_to",
      evidence_ref: null,
      created_by_peer_name: null,
    });
  }
  await publish("C10", WS, "conclusion", {
    body: "CHAINED-VIEW nat mentioned coffee in the chained session",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    session_name: "chained",
  });
  await publish("C11", WS, "conclusion", {
    body: "LOCKED-VIEW drawn where neo may not read",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    session_name: "locked",
  });
  // Validity window and the inactive flag (nonblocking finding 4).
  await publish("C12", WS, "conclusion", {
    body: "EXPIRED-VIEW nat lived in Chiang Mai",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    valid_from: "2019-01-01T00:00:00.000Z",
    valid_to: "2026-01-01T00:00:00.000Z",
  });
  await publish("C13", WS, "conclusion", {
    body: "FUTURE-VIEW nat will retire",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    valid_from: "2099-01-01T00:00:00.000Z",
  });
  await publish("C14", WS, "conclusion", {
    body: "INACTIVE-VIEW nat was switched off",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    is_active: false,
  });

  // Beta: a protected, out-of-scope conclusion (finding 2). No stored
  // summary: the reserved `type` vocabulary is sealed to five terms, so a
  // `summary` term cannot be seeded through the gated writer.
  const B = "beta-workspace";
  await call("context", "registerSession", { workspace_name: B, session_id: pad("prprivateb"), name: "private" });
  await call("context", "joinSession", { workspace_name: B, session_name: "private", peer_name: "claude" });
  await publish("B2", B, "conclusion", {
    body: "BETA-HIDDEN drawn in beta's private session",
    observer_peer_name: "neo",
    subject_peer_name: "nat",
    session_name: "private",
  });
  out.ok = true;
} catch (error) {
  const e = error as { name?: string; code?: string; path?: string; message?: string };
  out.error = { name: e?.name, code: e?.code, path: e?.path, message: String(e?.message ?? e) };
} finally {
  await service.close().catch(() => undefined);
}
console.log(JSON.stringify(out));
