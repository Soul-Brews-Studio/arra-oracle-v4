"""§15.5 round-trip test tier -- issue #8.

Proves (or honestly fails to prove, when unexecuted) that v4's tier-1 tables
(``workspaces``, ``peers``, ``sessions``, ``session_peers``, ``messages`` --
the SPEC §15 scope, per the 2026-09-20 correction on issue #8; conclusions,
revisions, evidence, scopes, dreaming and MCP parity are explicitly OUT) can
export to stock Honcho's own REST API, be read back by Honcho, and export
again to something equivalent under a stated, justified equivalence.

Submodules:
  ``pin``                 -- WHICH Honcho (git ref/commit) and WHICH config
                             this measures. Never a live shared instance (see
                             its docstring).
  ``target``              -- ``HonchoTarget`` protocol, an ``HttpHonchoTarget``
                             that speaks the real v3.2.0 REST routes, and a
                             ``FakeHonchoTarget`` that encodes the SAME
                             verified schema behaviour in-process so the
                             round-trip LOGIC has an executable test even when
                             no container can be started in this environment.
  ``bundle``              -- export v4 rows -> Honcho payloads, import, export
                             back, enumerate lossy fields.
  ``names``               -- reversible ACE-style encoding for a v4 name
                             outside Honcho's ``RESOURCE_NAME_PATTERN``.
  ``wire``                -- timestamp encode/decode across the REST boundary
                             (``datetime`` is not JSON-serializable).
  ``limits``              -- client-side pre-checks of stock Honcho's own
                             content/metadata/batch limits.
  ``dump``                -- read a real v4 dataset into a ``Tier1Bundle``
                             (``dump_tier1``), and write the SPEC §15.5
                             fixture bank (``build_spec_15_5_bank``).
  ``configuration_shape`` -- the shape stock Honcho actually stores for
                             workspace/session ``configuration`` (its four
                             reserved, typed sub-schema names).
  ``diff``                -- the reverse adapter (Honcho's read-back ->
                             ``Tier1Bundle``) and the real round-trip claim:
                             ``diff_against_input``, diffed against v4's OWN
                             input, not two Honcho reads of it.
  ``table_map``           -- the TABLE-level column map (v4 target-19 vs the
                             live Honcho v3.2.0 Postgres), with verdicts.
  ``table_sql``           -- a bundle as plain SQL INSERTs, applying exactly
                             ``table_map``'s conversions.
  ``table_measure``       -- the per-field REST + SQL read-back diff.
"""
