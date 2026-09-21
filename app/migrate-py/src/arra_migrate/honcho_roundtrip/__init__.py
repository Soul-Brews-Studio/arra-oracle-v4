"""§15.5 round-trip test tier -- issue #8.

Proves (or honestly fails to prove, when unexecuted) that v4's tier-1 tables
(``workspaces``, ``peers``, ``sessions``, ``session_peers``, ``messages`` --
the SPEC §15 scope, per the 2026-09-20 correction on issue #8; conclusions,
revisions, evidence, scopes, dreaming and MCP parity are explicitly OUT) can
export to stock Honcho's own REST API, be read back by Honcho, and export
again to something equivalent under a stated, justified equivalence.

Submodules:
  ``pin``    -- WHICH Honcho (git ref/commit) and WHICH config this measures.
                Never a live shared instance (see its docstring).
  ``target`` -- ``HonchoTarget`` protocol, an ``HttpHonchoTarget`` that speaks
                the real v3.2.0 REST routes, and a ``FakeHonchoTarget`` that
                encodes the SAME verified schema behaviour in-process so the
                round-trip LOGIC has an executable test even when no
                container can be started in this environment.
  ``bundle`` -- export v4 rows -> Honcho payloads, import, export back,
                diff under an explicit equivalence, enumerate lossy fields.
"""
