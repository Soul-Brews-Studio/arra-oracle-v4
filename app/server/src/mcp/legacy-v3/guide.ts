/**
 * `____IMPORTANT` (docs/overnight/V3-PARITY.md §4.5): static text, rewritten
 * for v4 rather than copied from v3. Plain text, like v3's guide.
 */
export function guide(): string {
  return [
    "arra-oracle v4 -- v3-compatible tools (arra-v3-compat/1)",
    "",
    "These oracle_* tools keep their v3 names and argument shapes, served by v4 over POST /mcp/<bank>.",
    "The bank in the URL is the only scope. Tenant or workspace arguments (tenantId, tenant_id, tenant, orgId, org_id, workspace_name, bank) are refused.",
    "",
    "What changed from v3:",
    "- Nothing is deleted. Every write is append-only; superseding or retiring an entry records a lifecycle event and keeps its history.",
    "- Superseded and retired entries are excluded from recall (search, ask, recap, reflect, inbox). They stay readable by id with oracle_read and oracle_list, flagged with superseded_by.",
    "- ids are v4 ids (21-character node ids, session names for threads). v3 ids (learning_..., UUID trace ids, integer thread ids) are not imported and answer legacy_id_unknown.",
    "- No file is read or written on the server. LanceDB is canonical; oracle_learn and oracle_handoff return file: null.",
    "- Search is keyword (character trigram, finds Thai inside words) or semantic, never a fused hybrid.",
    "- A field v4 cannot fill is present as null and named in compat_warnings; a refusal is {success:false, error, compat:{version, code, tool, detail}}.",
    "- A request body over 256 KiB is refused with HTTP 413 before any tool runs, so no tool can answer it. Publish larger content with POST /api/knowledge/<bank>/publishRevision (1 MiB cap).",
    "",
    "There is no MCP bridge: v4 never runs another MCP server or a command on your behalf.",
    "",
    "Tools not carried, and why:",
    "- oracle_mcp_call, oracle_mcp_list_tools: they ran a caller-chosen command on the server.",
    "- oracle_trace_link, oracle_trace_unlink: traces are immutable in v4; pass prevTraceId when creating a trace instead.",
    "- oracle_profile: a hardcoded persona profile, not knowledge.",
    "Calling a not-carried tool is indistinguishable from calling an unknown one.",
    "",
    "A tool that is listed works. A carried tool that v4 cannot serve yet is not listed, and calling it answers not_yet_available.",
  ].join("\n");
}
