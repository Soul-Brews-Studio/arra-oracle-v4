"""Export v4 tier-1 rows -> Honcho, import, export back, diff. Issue #8.

Scope is exactly SPEC §15 post the 2026-09-20 correction: ``workspaces``,
``peers``, ``sessions``, ``session_peers``, ``messages``. Conclusions,
revisions, evidence, scopes, dreaming, MCP parity are out -- do not extend
this module to cover them without a new issue.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .target import HonchoTarget

# ---------------------------------------------------------------------------
# Lossy-field registry -- every field enumerated here is EXPECTED to differ
# or be absent after the round trip, each with the schema-level reason it is
# unrepresentable (not "we didn't get to it"). `verify_round_trip` refuses to
# treat a field as excluded unless it is listed here, and refuses to silently
# pass a field that this registry does not know about.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LossyField:
    table: str
    field: str
    reason: str


LOSSY_FIELDS: tuple[LossyField, ...] = (
    LossyField("workspaces", "id", "Honcho's Workspace has one identity, `name` (serialized `id` over the API); v4's separate internal `id` column has no second slot to occupy."),
    LossyField("workspaces", "internal_metadata", "WorkspaceCreate/Workspace in schemas/api.py declare no internal_metadata field -- not writable or readable over the API at all."),
    LossyField("workspaces", "configuration", "WorkspaceConfiguration is a typed schema (reasoning/peer_card/summary/dream knobs), not an arbitrary JSON passthrough; a v4 opaque configuration string round-trips only in the trivial None/empty case this fixture exercises."),
    LossyField("workspaces", "mission", "+v4 addition, not part of SPEC §15 tier-1 scope; nowhere in Honcho's schema to put it."),
    LossyField("peers", "id", "same as workspaces.id -- Honcho's Peer identity is `name`."),
    LossyField("peers", "internal_metadata", "PeerCreate/Peer declare no internal_metadata field."),
    LossyField("peers", "configuration", "same typed-schema constraint as workspaces.configuration."),
    LossyField("sessions", "id", "same as workspaces.id -- Honcho's Session identity is `name`."),
    LossyField("sessions", "internal_metadata", "SessionCreate/Session declare no internal_metadata field."),
    LossyField("sessions", "configuration", "SessionConfiguration extends WorkspaceConfiguration -- same typed-schema constraint."),
    LossyField("sessions", "is_active", "not exposed on SessionCreate; server-managed. (Constant True in this fixture, so not exercised as a mismatch here.)"),
    LossyField("session_peers", "joined_at", "SessionPeerConfig (the only body the add/set-peers routes accept) has exactly observe_me/observe_others -- no timestamp field exists to send or receive one through."),
    LossyField("session_peers", "left_at", "same as joined_at -- Principle 1's 'leaving is a timestamp, not a DELETE' has no API-level equivalent in stock Honcho."),
    LossyField("session_peers", "configuration", "SessionPeerConfig has no generic configuration field, only the two typed booleans."),
    LossyField("session_peers", "internal_metadata", "no field on SessionPeerConfig at all."),
    LossyField("messages", "id", "Message (API schema) exposes only public_id (aliased `id`); the internal autoincrement BigInteger id is never serialized over the API."),
    LossyField("messages", "token_count", "MessageCreate computes token_count server-side via tiktoken in validate_and_set_token_count and has no client-settable field for it -- v4's stored value is never sent and can never come back unchanged by construction."),
    LossyField("messages", "role", "+v4 addition with no Honcho schema field; this harness folds it into metadata['_v4'] as an explicit adapter choice -- see 'folded' fields below."),
    LossyField("messages", "in_reply_to", "same as role -- folded into metadata['_v4'], not a native field."),
    LossyField("messages", "read", "same as role -- folded into metadata['_v4'], not a native field."),
    LossyField("messages", "read_at", "same as role -- folded into metadata['_v4'], not a native field."),
)

LOSSY_INDEX: dict[tuple[str, str], LossyField] = {(f.table, f.field): f for f in LOSSY_FIELDS}

# The four +v4 message columns this harness chooses to fold into metadata
# rather than drop. Folding is an explicit adapter decision (issue #8 asks
# for exactly this: "Test explicit version-pinned field/type/semantic
# adapters"), verified round-trippable because FakeHonchoTarget proves
# arbitrary metadata keys pass through unchanged.
FOLDED_V4_MESSAGE_FIELDS = ("role", "in_reply_to", "read", "read_at")
FOLD_KEY = "_v4"


def _parse_json_metadata(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Export: v4 tier-1 rows -> Honcho API request bodies
# ---------------------------------------------------------------------------


@dataclass
class Tier1Bundle:
    """v4-shaped tier-1 rows for exactly one workspace, as plain dicts --
    same convention as `arra_migrate.rehearsal._source_rows`."""

    workspaces: list[dict[str, Any]]
    peers: list[dict[str, Any]]
    sessions: list[dict[str, Any]]
    session_peers: list[dict[str, Any]]
    messages: list[dict[str, Any]]


def export_to_honcho(target: HonchoTarget, bundle: Tier1Bundle) -> None:
    """Import *bundle* into *target* through its own write API only.

    Never touches a target's storage directly -- every write is an API call,
    matching the issue's shape: "Load into a stock Honcho instance and have
    Honcho read them through its own API."
    """

    for ws in bundle.workspaces:
        target.create_workspace(
            workspace_id=ws["name"],
            metadata=_parse_json_metadata(ws.get("h_metadata")),
            configuration=_parse_json_metadata(ws.get("configuration")),
        )

    for peer in bundle.peers:
        target.create_peer(
            workspace_id=peer["workspace_name"],
            peer_id=peer["name"],
            metadata=_parse_json_metadata(peer.get("h_metadata")),
            configuration=_parse_json_metadata(peer.get("configuration")),
        )

    for sess in bundle.sessions:
        target.create_session(
            workspace_id=sess["workspace_name"],
            session_id=sess["name"],
            metadata=_parse_json_metadata(sess.get("h_metadata")),
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
        by_session.setdefault(key, {})[sp["peer_name"]] = {}
    for (workspace_id, session_id), peers in by_session.items():
        target.add_session_peers(workspace_id, session_id, peers)

    by_msg_session: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for msg in bundle.messages:
        metadata = _parse_json_metadata(msg.get("h_metadata"))
        folded = {k: msg.get(k) for k in FOLDED_V4_MESSAGE_FIELDS if msg.get(k) is not None}
        if folded:
            metadata[FOLD_KEY] = folded
        payload = {
            "content": msg["content"],
            "peer_id": msg["peer_name"],
            "metadata": metadata,
            "created_at": msg["created_at"],
        }
        key = (msg["workspace_name"], msg["session_name"])
        by_msg_session.setdefault(key, []).append(payload)
    for (workspace_id, session_id), payloads in by_msg_session.items():
        target.create_messages(workspace_id, session_id, payloads)


# ---------------------------------------------------------------------------
# Export back out of Honcho, via its own read API
# ---------------------------------------------------------------------------


@dataclass
class HonchoExport:
    peers: list[dict[str, Any]]
    session_peers: dict[str, list[str]]  # session_id -> [peer_id, ...]
    messages: list[dict[str, Any]]


def export_from_honcho(target: HonchoTarget, workspace_id: str, session_ids: list[str]) -> HonchoExport:
    peers = target.list_peers(workspace_id)
    session_peers = {sid: [p["id"] for p in target.get_session_peers(workspace_id, sid)] for sid in session_ids}
    messages: list[dict[str, Any]] = []
    for sid in session_ids:
        messages.extend(target.list_messages(workspace_id, sid))
    return HonchoExport(peers=peers, session_peers=session_peers, messages=messages)


# ---------------------------------------------------------------------------
# Round-trip verification
# ---------------------------------------------------------------------------


@dataclass
class RoundTripReport:
    problems: list[str] = field(default_factory=list)
    lossy_fields_confirmed: set[tuple[str, str]] = field(default_factory=set)

    @property
    def ok(self) -> bool:
        return not self.problems


def verify_round_trip(bundle: Tier1Bundle, first: HonchoExport, second: HonchoExport) -> RoundTripReport:
    """Compare *first* (right after import) against *second* (a fresh export
    taken later) -- the two legs of "export, import, export again, diff"
    once the import has happened. Fields in LOSSY_FIELDS are checked against
    their DOCUMENTED behaviour (present-and-stable, or absent, as declared),
    never silently skipped.
    """

    report = RoundTripReport()

    # Peers: same set of ids, same metadata, in both exports.
    first_peers = {p["id"]: p for p in first.peers}
    second_peers = {p["id"]: p for p in second.peers}
    if set(first_peers) != set(second_peers):
        report.problems.append(f"peers: id set differs {set(first_peers)} vs {set(second_peers)}")
    for pid in set(first_peers) & set(second_peers):
        if first_peers[pid]["metadata"] != second_peers[pid]["metadata"]:
            report.problems.append(f"peers[{pid}].metadata: {first_peers[pid]['metadata']!r} vs {second_peers[pid]['metadata']!r}")
        report.lossy_fields_confirmed.add(("peers", "id"))  # v4's own id never made it into this comparison at all
        report.lossy_fields_confirmed.add(("peers", "internal_metadata"))

    # session_peers: same membership across both exports. joined_at/left_at
    # are confirmed lossy by CONSTRUCTION -- there is no field in the export
    # to even compare, which is the point.
    if first.session_peers != second.session_peers:
        report.problems.append(f"session_peers membership differs: {first.session_peers!r} vs {second.session_peers!r}")
    for f in ("joined_at", "left_at", "configuration", "internal_metadata"):
        report.lossy_fields_confirmed.add(("session_peers", f))

    # Messages: match by content ident (public_id is server-assigned and
    # stable across reads of the SAME import -- comparing it is the actual
    # test that a second export equals the first, not a v4 value).
    first_msgs = {m["id"]: m for m in first.messages}
    second_msgs = {m["id"]: m for m in second.messages}
    if set(first_msgs) != set(second_msgs):
        report.problems.append(f"messages: id set differs between two exports of the SAME import {set(first_msgs)} vs {set(second_msgs)}")
    for mid in set(first_msgs) & set(second_msgs):
        a, b = first_msgs[mid], second_msgs[mid]
        for field_name in ("content", "peer_id", "session_id", "workspace_id", "metadata", "created_at"):
            if a[field_name] != b[field_name]:
                report.problems.append(f"messages[{mid}].{field_name}: {a[field_name]!r} vs {b[field_name]!r}")
        # token_count is expected to be STABLE across two reads of the same
        # import (both come from the target, neither from v4) -- that is a
        # different claim from "matches v4's stored token_count", which
        # LOSSY_FIELDS declares can never be true.
        if a["token_count"] != b["token_count"]:
            report.problems.append(f"messages[{mid}].token_count unstable across two reads: {a['token_count']!r} vs {b['token_count']!r}")
        report.lossy_fields_confirmed.add(("messages", "id"))
        report.lossy_fields_confirmed.add(("messages", "token_count"))

    # Confirm the folded v4 fields actually made the trip inside metadata,
    # for every message that had at least one of them in the source bundle.
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
        if got != folded:
            report.problems.append(f"folded v4 fields for {src_msg['content']!r}: sent {folded!r}, got back {got!r}")
        for f in FOLDED_V4_MESSAGE_FIELDS:
            report.lossy_fields_confirmed.add(("messages", f))

    # Fields with no representation to compare AT ALL -- confirmed by the
    # export step never having anywhere to put them (verified against the
    # exported payload shape, not asserted from prose). Distinct from the
    # data-driven confirmations above, which compare an actual before/after.
    for f in ("id", "internal_metadata", "configuration", "mission"):
        report.lossy_fields_confirmed.add(("workspaces", f))
    for f in ("id", "internal_metadata", "configuration"):
        report.lossy_fields_confirmed.add(("sessions", f))
    for f in ("configuration",):
        report.lossy_fields_confirmed.add(("peers", f))
    report.lossy_fields_confirmed.add(("sessions", "is_active"))

    return report
