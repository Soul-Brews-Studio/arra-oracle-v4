"""Export v4 tier-1 rows -> Honcho, import, export back. Issue #8.

Scope is exactly SPEC §15 post the 2026-09-20 correction: ``workspaces``,
``peers``, ``sessions``, ``session_peers``, ``messages``. Conclusions,
revisions, evidence, scopes, dreaming, MCP parity are out -- do not extend
this module to cover them without a new issue.

The against-the-INPUT diff lives in ``diff.py``, not here -- this module is
one direction only (v4 -> Honcho, and Honcho's own read-back), so a bug in
the diff can never hide inside the same file as the code it is checking.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import limits, names, wire
from .target import HonchoTarget

# ---------------------------------------------------------------------------
# Lossy-field registry -- every field enumerated here is EXPECTED to differ
# or be absent after the round trip, each with the schema-level reason it is
# unrepresentable (not "we didn't get to it"). `diff.diff_against_input`
# refuses to treat a field as excluded unless it is listed here, and refuses
# to silently pass a column this registry does not know about.
#
# Every reason below was checked 2026-09-26 against `plastic-labs/honcho` at
# the pinned commit (`pin.HONCHO_V3_2_0`) -- `src/schemas/api.py` and
# `src/schemas/configuration.py` -- not carried over from an earlier,
# unverified draft of this file. Two entries changed as a result of that
# re-check; see their reasons for what was wrong before and why.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LossyField:
    table: str
    field: str
    reason: str


LOSSY_FIELDS: tuple[LossyField, ...] = (
    LossyField("workspaces", "id", "Honcho's Workspace has one identity, `name` (serialized `id` over the API); v4's separate internal `id` column has no second slot to occupy."),
    LossyField("workspaces", "internal_metadata", "WorkspaceCreate/Workspace in schemas/api.py declare no internal_metadata field -- not writable or readable over the API at all."),
    LossyField("workspaces", "created_at", "WorkspaceCreate (schemas/api.py) has no created_at field at all -- Honcho stamps the row's own creation wall-clock time server-side; v4's historical created_at is never sent."),
    LossyField(
        "workspaces", "configuration",
        "WorkspaceConfiguration has `model_config = ConfigDict(extra=\"allow\")` (schemas/configuration.py:117), so an "
        "arbitrary top-level key DOES round-trip -- this is narrower than 'not a passthrough' (an earlier, unverified "
        "version of this reason claimed exactly that, wrongly). The real loss is scoped to the four RESERVED key names "
        "the schema types (`reasoning`, `peer_card`, `summary`, `dream`): a value placed under one of those is parsed "
        "into that nested typed model, which silently drops any sub-key it does not itself declare (pydantic's default "
        "for a nested BaseModel is to ignore, not preserve, unknown fields) -- e.g. `{\"peer_card\": {\"max_tokens\": 500}}` "
        "comes back with `max_tokens` gone. A workspace configuration that avoids those four names round-trips exactly."
    ),
    LossyField("workspaces", "mission", "+v4 addition, not part of SPEC §15 tier-1 scope; nowhere in Honcho's schema to put it."),
    LossyField("peers", "id", "same as workspaces.id -- Honcho's Peer identity is `name`."),
    LossyField("peers", "internal_metadata", "PeerCreate/Peer declare no internal_metadata field."),
    LossyField("peers", "created_at", "same as workspaces.created_at -- PeerSpec/PeerCreate have no created_at field; Honcho stamps its own."),
    LossyField("sessions", "id", "same as workspaces.id -- Honcho's Session identity is `name`."),
    LossyField("sessions", "internal_metadata", "SessionCreate/Session declare no internal_metadata field."),
    LossyField("sessions", "created_at", "same as workspaces.created_at -- SessionCreate has no created_at field; Honcho stamps its own."),
    LossyField("sessions", "configuration", "SessionConfiguration extends WorkspaceConfiguration (schemas/configuration.py:137) -- same reserved-key-collision constraint, same reason text, as workspaces.configuration above."),
    LossyField("sessions", "is_active", "not exposed on SessionCreate; server-managed. (Constant True in this fixture, so not exercised as a mismatch here.)"),
    LossyField("session_peers", "joined_at", "SessionPeerConfig (the only body the add/set-peers routes accept) has exactly observe_me/observe_others -- no timestamp field exists to send or receive one through."),
    LossyField("session_peers", "left_at", "same as joined_at -- Principle 1's 'leaving is a timestamp, not a DELETE' has no representation in the two-boolean SessionPeerConfig body this harness sends. Honcho DOES have DELETE .../sessions/{id}/peers; not calling it is this harness's own policy choice, not an API limitation -- see export_to_honcho's docstring for the resulting behaviour: a departed peer is still sent, and stays, as a CURRENT member."),
    LossyField("session_peers", "configuration", "SessionPeerConfig has no generic configuration field, only the two typed booleans."),
    LossyField("session_peers", "internal_metadata", "no field on SessionPeerConfig at all."),
    LossyField("messages", "id", "Message (API schema) exposes only public_id (aliased `id`); the internal autoincrement BigInteger id is never serialized over the API."),
    LossyField("messages", "public_id", "MessageCreate (schemas/api.py) has no id/public_id field at all -- v4's public_id is never sent; Honcho assigns its own server-side id/public_id on creation, unrelated to v4's value."),
    LossyField("messages", "token_count", "MessageCreate computes token_count server-side via tiktoken in validate_and_set_token_count and has no client-settable field for it -- v4's stored value is never sent and can never come back unchanged by construction."),
    LossyField("messages", "role", "+v4 addition with no Honcho schema field; this harness folds it into metadata['_v4'] as an explicit adapter choice -- see 'folded' fields below."),
    LossyField("messages", "in_reply_to", "same as role -- folded into metadata['_v4'], not a native field."),
    LossyField("messages", "read", "same as role -- folded into metadata['_v4'], not a native field."),
    LossyField("messages", "read_at", "same as role -- folded into metadata['_v4'], not a native field."),
    LossyField("messages", "internal_metadata", "MessageCreate/Message (schemas/api.py) declare no internal_metadata field -- same gap as workspaces/peers/sessions.internal_metadata."),
    # target-19 additions (the isolated target-19 candidate's Message model --
    # see dump.py) -- absent from the active-15 shape, present when
    # `dump_tier1` reads a target-19 dataset. Unlike role/in_reply_to/read/
    # read_at, these are NOT folded into metadata in this phase -- that is a
    # deliberate scope line, not an oversight (see this module's own
    # docstring and the phase-1 brief); a future issue can fold them the same
    # way once target-19 is the active schema.
    LossyField("messages", "source_namespace", "[P] source-identity addition (DESIGN.md §5 / #23 rev 2), target-19 only; Honcho's Message schema has no source-identity concept, folded or otherwise."),
    LossyField("messages", "source_message_id", "same as source_namespace -- part of the same all-or-none source-identity triple."),
    LossyField("messages", "source_payload_digest", "same as source_namespace."),
    LossyField("messages", "source_created_at", "same as source_namespace -- the source's own timestamp, distinct from `created_at`."),
    LossyField(
        "messages", "ingested_at",
        "target-19 addition, NOT NULL -- the recorded exception to SPEC §15.1/§15.2 inv.1 ('nullable columns only' for "
        "a v4 addition); see app/docs/contracts/source-ingestion-v1.md's 2026-09-26 amendment and DECISIONS.md R15. "
        "Honcho's Message schema has no ingestion-time concept, and being NOT NULL means this column always carries a "
        "real value to lose, unlike a nullable +v4 addition that might legitimately be absent anyway."
    ),
)

LOSSY_INDEX: dict[tuple[str, str], LossyField] = {(f.table, f.field): f for f in LOSSY_FIELDS}

# Entries that CANNOT be confirmed by inspecting an outgoing payload or a
# round-trip diff against THIS harness's own fixtures, because the API has a
# slot for the field (`configuration` IS sent) -- the loss is conditional on
# the v4 payload using one of the four reserved sub-schema key names. As of
# the 2026-09-26 fix round, `diff.diff_against_input` no longer treats this
# whole column as unconditionally lossy either way (see `_normalized_
# configuration`): it compares the INPUT, shaped through `apply_workspace_
# configuration_shape` the same way stock Honcho would store it, against
# Honcho's actual answer -- so even `dump.build_spec_15_5_bank`'s own
# workspace configuration (`{"peer_card": {"max_tokens": 500}}`, a RESERVED
# key with an undeclared sub-key -- this bank does NOT avoid the collision,
# an earlier version of this comment wrongly claimed it did) round-trips with
# no reported problem, because both sides of the comparison are shaped
# identically. `WorkspaceConfigurationReservedKeyCollisionTests` (see the
# diff test module) exercises the collision more pointedly, with an
# `notes`-style extra key present too, to prove the two are told apart. Kept
# in a SEPARATE set, deliberately never merged into
# `lossy_fields_confirmed`, so a reader (and
# `test_every_declared_lossy_field_is_actually_confirmed_not_just_asserted`)
# can tell "measured against the shared bank" from "known from reading the
# pinned schema, exercised by its own dedicated test" apart.
LOSSY_FIELDS_BY_CONSTRUCTION: frozenset[tuple[str, str]] = frozenset(
    {("workspaces", "configuration"), ("sessions", "configuration")}
)

# The four +v4 message columns this harness chooses to fold into metadata
# rather than drop. Folding is an explicit adapter decision (issue #8 asks
# for exactly this: "Test explicit version-pinned field/type/semantic
# adapters"), verified round-trippable because FakeHonchoTarget proves
# arbitrary metadata keys pass through unchanged.
FOLDED_V4_MESSAGE_FIELDS = ("role", "in_reply_to", "read", "read_at")
FOLD_KEY = "_v4"

# target-19-only message columns this phase declares lossy outright (see
# LOSSY_FIELDS above) rather than folding.
TARGET19_ONLY_MESSAGE_FIELDS = (
    "source_namespace", "source_message_id", "source_payload_digest",
    "source_created_at", "ingested_at",
)


def _parse_json_metadata(raw: Any) -> dict[str, Any]:
    """Always a NEW dict, never the caller's own -- `_message_payload` (and
    `_workspace_payload`/`_peer_payload`/`_session_payload`) mutate the
    result in place (folding `FOLD_KEY` into a message's metadata, for
    example). Before this fix, a `raw` that was already a `dict` (as opposed
    to a JSON string -- both are valid `Tier1Bundle` shapes, see this
    module's docstring) was returned BY REFERENCE, so exporting a bundle
    silently wrote `_v4` back into the caller's own input row. `dump_tier1`
    always reads `h_metadata` as a JSON string (LanceDB column type), so this
    never fired there -- only a hand-built or in-memory `Tier1Bundle` with
    dict-shaped metadata could hit it. 2026-09-26 fix-round finding."""

    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Export: v4 tier-1 rows -> Honcho API request bodies
# ---------------------------------------------------------------------------


@dataclass
class Tier1Bundle:
    """v4-shaped tier-1 rows for exactly one workspace, as plain dicts --
    same convention as `arra_migrate.rehearsal._source_rows`. A `messages`
    row MAY carry the five target-19-only columns (see
    `TARGET19_ONLY_MESSAGE_FIELDS`) or omit them entirely -- every function in
    this module reads message fields with `.get(...)`, never direct
    indexing, for exactly that reason."""

    workspaces: list[dict[str, Any]]
    peers: list[dict[str, Any]]
    sessions: list[dict[str, Any]]
    session_peers: list[dict[str, Any]]
    messages: list[dict[str, Any]]


def _workspace_payload(ws: dict[str, Any]) -> dict[str, Any]:
    """The exact body `HttpHonchoTarget.create_workspace` would send. A pure
    function (no target, no I/O) so tests can inspect the payload SHAPE
    directly instead of asserting from prose what it does or doesn't carry.
    """
    return {
        "id": names.honcho_name(ws["name"]),
        "metadata": _parse_json_metadata(ws.get("h_metadata")),
        "configuration": _parse_json_metadata(ws.get("configuration")),
    }


def _peer_payload(peer: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": names.honcho_name(peer["name"]),
        "metadata": _parse_json_metadata(peer.get("h_metadata")),
        "configuration": _parse_json_metadata(peer.get("configuration")),
    }


def _session_payload(sess: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": names.honcho_name(sess["name"]),
        "metadata": _parse_json_metadata(sess.get("h_metadata")),
        "configuration": _parse_json_metadata(sess.get("configuration")),
    }


def _message_payload(msg: dict[str, Any]) -> dict[str, Any]:
    """Content limit and metadata-limit pre-checks happen HERE, before THIS
    message's own request body is built -- a batch of 100 that fails on
    message 97 has already sent 96 messages nobody asked to send partially
    (issue #8 repro E is the same class of defect one step earlier: send
    first, discover the limit from a 422 second). Scoped to messages only --
    `export_to_honcho` still creates the workspace/peers/sessions/session_peers
    before reaching any message, so a message-level limit violation is
    discovered only after those earlier resources already exist on the
    target, not before every request in the whole export."""

    ident = msg.get("public_id") or msg.get("id")
    limits.check_content_limit(msg["content"], where=f"messages[{ident}].content")

    metadata = _parse_json_metadata(msg.get("h_metadata"))
    folded = {k: msg.get(k) for k in FOLDED_V4_MESSAGE_FIELDS if msg.get(k) is not None}
    if folded:
        # `read_at` is a `datetime` -- wire-encode it too, or it hits the same
        # "Object of type datetime is not JSON serializable" defect this
        # module exists to fix, just one level deeper inside `metadata`.
        folded = {k: (wire.to_wire_timestamp(v) if isinstance(v, datetime) else v) for k, v in folded.items()}
        metadata[FOLD_KEY] = folded
    limits.check_metadata_limits(metadata, where=f"messages[{ident}].metadata")

    return {
        "content": msg["content"],
        "peer_id": names.honcho_name(msg["peer_name"]),
        "metadata": metadata,
        "created_at": wire.to_wire_timestamp(msg["created_at"]),
    }


def _chunked(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def export_to_honcho(target: HonchoTarget, bundle: Tier1Bundle) -> None:
    """Import *bundle* into *target* through its own write API only.

    Never touches a target's storage directly -- every write is an API call,
    matching the issue's shape: "Load into a stock Honcho instance and have
    Honcho read them through its own API."

    Departed-peer handling, declared explicitly (not left implicit in a
    comment buried below): a v4 `session_peers` row with `left_at` set (the
    peer has already left, per Principle 1) is still sent here as a CURRENT
    member, because `add_session_peers` has no way to express "was here,
    isn't now" and this harness makes no attempt to translate that into a
    removal call (Honcho DOES have `DELETE .../sessions/{id}/peers`, but
    calling it is a policy choice -- "reproduce v4's history" vs "reproduce
    v4's current state" -- this issue does not decide). `left_at` and
    `joined_at` are declared LOSSY for exactly this reason, and
    `diff.diff_against_input` records the resulting membership fact under
    `diff.DiffReport.declared_notes` rather than silently matching or
    silently failing on it.
    """

    for ws in bundle.workspaces:
        payload = _workspace_payload(ws)
        limits.check_metadata_limits(payload["metadata"], where=f"workspaces[{ws['name']}].metadata")
        limits.check_metadata_limits(payload["configuration"], where=f"workspaces[{ws['name']}].configuration")
        target.create_workspace(workspace_id=payload["id"], metadata=payload["metadata"], configuration=payload["configuration"])

    for peer in bundle.peers:
        payload = _peer_payload(peer)
        limits.check_metadata_limits(payload["metadata"], where=f"peers[{peer['name']}].metadata")
        limits.check_metadata_limits(payload["configuration"], where=f"peers[{peer['name']}].configuration")
        target.create_peer(workspace_id=names.honcho_name(peer["workspace_name"]), peer_id=payload["id"], metadata=payload["metadata"], configuration=payload["configuration"])

    for sess in bundle.sessions:
        payload = _session_payload(sess)
        limits.check_metadata_limits(payload["metadata"], where=f"sessions[{sess['name']}].metadata")
        limits.check_metadata_limits(payload["configuration"], where=f"sessions[{sess['name']}].configuration")
        target.create_session(
            workspace_id=names.honcho_name(sess["workspace_name"]), session_id=payload["id"],
            metadata=payload["metadata"], configuration=payload["configuration"],
        )

    # Group session_peers by (workspace, session) so one add_session_peers
    # call carries every peer for that session -- matches the real route,
    # which takes a dict of peer_id -> config per call.
    by_session: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
    for sp in bundle.session_peers:
        key = (sp["workspace_name"], sp["session_name"])
        # Only observe_me/observe_others exist on the target side (see
        # LOSSY_FIELDS) -- v4 has no such columns at all yet, so default both
        # to Honcho's own default (None -> server default) rather than
        # inventing a v4 source for them.
        by_session.setdefault(key, {})[names.honcho_name(sp["peer_name"])] = {}
    for (workspace_name, session_name), peers in by_session.items():
        target.add_session_peers(names.honcho_name(workspace_name), names.honcho_name(session_name), peers)

    # Sorted by seq_in_session (within each session) BEFORE chunking, so a
    # 100-message cap never splits a session's order-dependent history at an
    # arbitrary point -- issue #8 repro D measured that seq order was never
    # even sent in order, let alone verified.
    ordered = sorted(bundle.messages, key=lambda m: (m["workspace_name"], m["session_name"], m["seq_in_session"]))
    by_msg_session: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for msg in ordered:
        key = (msg["workspace_name"], msg["session_name"])
        by_msg_session.setdefault(key, []).append(_message_payload(msg))
    for (workspace_name, session_name), payloads in by_msg_session.items():
        for chunk in _chunked(payloads, limits.MESSAGE_BATCH_MAX):
            target.create_messages(names.honcho_name(workspace_name), names.honcho_name(session_name), chunk)


# ---------------------------------------------------------------------------
# Export back out of Honcho, via its own read API
# ---------------------------------------------------------------------------


@dataclass
class HonchoExport:
    workspace: dict[str, Any]
    sessions: list[dict[str, Any]]
    peers: list[dict[str, Any]]
    session_peers: dict[str, list[str]]  # v4 session_name -> [honcho peer id, ...]
    messages: list[dict[str, Any]]


def export_from_honcho(target: HonchoTarget, workspace_name: str, session_names: list[str]) -> HonchoExport:
    """Read *workspace_name* back out of *target*, by its own read API only.

    Takes v4 NAMES (the same currency `Tier1Bundle` uses everywhere else) and
    encodes to the wire id internally -- callers never have to know or
    reconstruct the encoded form themselves.
    """

    workspace_id = names.honcho_name(workspace_name)
    workspace = target.get_workspace(workspace_id)
    sessions = target.list_sessions(workspace_id)
    peers = target.list_peers(workspace_id)
    session_peers = {
        session_name: [p["id"] for p in target.get_session_peers(workspace_id, names.honcho_name(session_name))]
        for session_name in session_names
    }
    messages: list[dict[str, Any]] = []
    for session_name in session_names:
        messages.extend(target.list_messages(workspace_id, names.honcho_name(session_name)))
    return HonchoExport(workspace=workspace, sessions=sessions, peers=peers, session_peers=session_peers, messages=messages)


def confirm_fields_absent_from_export(bundle: Tier1Bundle) -> set[tuple[str, str]]:
    """Measure -- not assert -- which LOSSY_FIELDS entries this bundle's data
    actually proves are absent from the payload `export_to_honcho` builds.

    A field is added to the result ONLY when the source row carries a real,
    non-null value for it AND that value (or its key) is genuinely missing
    from the payload the exporter would send. A null/default source value is
    SKIPPED, not confirmed -- absence of nothing proves nothing. This is the
    fix for the 2026-09-21 audit finding: an earlier version of this module
    added these same entries unconditionally, so a fixture with every
    optional field left null would still report them "confirmed".
    """

    confirmed: set[tuple[str, str]] = set()

    for ws in bundle.workspaces:
        payload = _workspace_payload(ws)
        if ws.get("id") and ws["id"] != payload["id"]:
            confirmed.add(("workspaces", "id"))
        if ws.get("internal_metadata") and "internal_metadata" not in payload:
            confirmed.add(("workspaces", "internal_metadata"))
        if ws.get("mission") and "mission" not in payload:
            confirmed.add(("workspaces", "mission"))

    for peer in bundle.peers:
        payload = _peer_payload(peer)
        if peer.get("id") and peer["id"] != payload["id"]:
            confirmed.add(("peers", "id"))
        if peer.get("internal_metadata") and "internal_metadata" not in payload:
            confirmed.add(("peers", "internal_metadata"))

    for sess in bundle.sessions:
        payload = _session_payload(sess)
        if sess.get("id") and sess["id"] != payload["id"]:
            confirmed.add(("sessions", "id"))
        if sess.get("internal_metadata") and "internal_metadata" not in payload:
            confirmed.add(("sessions", "internal_metadata"))
        if sess.get("is_active") is not None and "is_active" not in payload:
            confirmed.add(("sessions", "is_active"))

    for sp in bundle.session_peers:
        # export_to_honcho sends `{}` per peer to add_session_peers (see its
        # body) -- never forwards any of these four columns. Only confirm
        # when the source actually had something in the slot to lose.
        if sp.get("joined_at") is not None:
            confirmed.add(("session_peers", "joined_at"))
        if sp.get("left_at") is not None:
            confirmed.add(("session_peers", "left_at"))
        if sp.get("configuration") is not None:
            confirmed.add(("session_peers", "configuration"))
        if sp.get("internal_metadata") is not None:
            confirmed.add(("session_peers", "internal_metadata"))

    return confirmed


# ---------------------------------------------------------------------------
# "Stable across two reads of the same import" -- a secondary, narrower check
# than `diff.diff_against_input`. See that module for the comparison that
# actually matters: the ORIGINAL v4 bundle against a round-tripped one.
# ---------------------------------------------------------------------------


@dataclass
class RoundTripReport:
    problems: list[str] = field(default_factory=list)
    lossy_fields_confirmed: set[tuple[str, str]] = field(default_factory=set)
    lossy_fields_by_construction: set[tuple[str, str]] = field(default_factory=set)

    @property
    def ok(self) -> bool:
        return not self.problems


def verify_round_trip(bundle: Tier1Bundle, first: HonchoExport, second: HonchoExport) -> RoundTripReport:
    """Compare *first* (right after import) against *second* (a fresh export
    taken later) -- both exports of the SAME import, so this proves Honcho's
    own reads are stable, not that either one matches v4's input (that is
    `diff.diff_against_input`'s job). Fields in LOSSY_FIELDS are checked
    against their DOCUMENTED behaviour (present-and-stable, or absent, as
    declared), never silently skipped.
    """

    report = RoundTripReport()

    first_peers = {p["id"]: p for p in first.peers}
    second_peers = {p["id"]: p for p in second.peers}
    if set(first_peers) != set(second_peers):
        report.problems.append(f"peers: id set differs {set(first_peers)} vs {set(second_peers)}")
    for pid in set(first_peers) & set(second_peers):
        if first_peers[pid]["metadata"] != second_peers[pid]["metadata"]:
            report.problems.append(f"peers[{pid}].metadata: {first_peers[pid]['metadata']!r} vs {second_peers[pid]['metadata']!r}")

    if first.session_peers != second.session_peers:
        report.problems.append(f"session_peers membership differs: {first.session_peers!r} vs {second.session_peers!r}")

    first_msgs = {m["id"]: m for m in first.messages}
    second_msgs = {m["id"]: m for m in second.messages}
    if set(first_msgs) != set(second_msgs):
        report.problems.append(f"messages: id set differs between two exports of the SAME import {set(first_msgs)} vs {set(second_msgs)}")
    for mid in set(first_msgs) & set(second_msgs):
        a, b = first_msgs[mid], second_msgs[mid]
        for field_name in ("content", "peer_id", "session_id", "workspace_id", "metadata", "created_at"):
            if a[field_name] != b[field_name]:
                report.problems.append(f"messages[{mid}].{field_name}: {a[field_name]!r} vs {b[field_name]!r}")
        if a["token_count"] != b["token_count"]:
            report.problems.append(f"messages[{mid}].token_count unstable across two reads: {a['token_count']!r} vs {b['token_count']!r}")
        report.lossy_fields_confirmed.add(("messages", "id"))
        report.lossy_fields_confirmed.add(("messages", "token_count"))

    by_content = {m["content"]: m for m in second.messages}
    for src_msg in bundle.messages:
        folded = {k: src_msg.get(k) for k in FOLDED_V4_MESSAGE_FIELDS if src_msg.get(k) is not None}
        if not folded:
            continue
        target_msg = by_content.get(src_msg["content"])
        if target_msg is None:
            report.problems.append(f"message with content {src_msg['content']!r}: not found in export to check folded v4 fields")
            continue
        got = target_msg["metadata"].get(FOLD_KEY, {})
        want = {k: (wire.to_wire_timestamp(v) if hasattr(v, "tzinfo") else v) for k, v in folded.items()}
        if got != want:
            report.problems.append(f"folded v4 fields for {src_msg['content']!r}: sent {want!r}, got back {got!r}")
        for f in FOLDED_V4_MESSAGE_FIELDS:
            report.lossy_fields_confirmed.add(("messages", f))

    report.lossy_fields_confirmed |= confirm_fields_absent_from_export(bundle)
    report.lossy_fields_by_construction |= LOSSY_FIELDS_BY_CONSTRUCTION

    return report
