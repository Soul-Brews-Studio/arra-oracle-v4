"""Reverse adapter + the real round-trip diff: against v4's INPUT. Issue #8.

`bundle.verify_round_trip` compares two Honcho reads of the SAME import --
useful, but it is not a diff against v4 at all (issue #8 repro B: a
`CorruptingHonchoTarget` that drops metadata, drops a message and reverses
order passes it with `ok=True`, because both reads see the SAME corruption).

This module is the actual claim SPEC §15.5 makes: dump v4, import into
Honcho, export back out, and diff THAT against the original dump. Every
column on every tier-1 table must be either declared in `bundle.LOSSY_FIELDS`
(with a reason) or provably equal after the stated normalization -- a column
this module has never seen before, on either side, is a problem, not a
silent pass (issue #8 repro C: the target-19 `source_*`/`ingested_at`
columns dropped with `flagged=set()`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import names, wire
from .bundle import (
    FOLD_KEY,
    FOLDED_V4_MESSAGE_FIELDS,
    LOSSY_FIELDS_BY_CONSTRUCTION,
    LOSSY_INDEX,
    HonchoExport,
    Tier1Bundle,
    _parse_json_metadata,
)
from .configuration_shape import apply_workspace_configuration_shape


def _has_value(v: Any) -> bool:
    try:
        return v not in (None, "", {}, [])
    except TypeError:
        return v is not None


def _parse_ts(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str):
        return wire.from_wire_timestamp(value)
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    raise TypeError(f"unexpected timestamp value from a Honcho export: {value!r}")


def _ts_equal(a: Any, b: Any) -> bool:
    """Equal regardless of whether either side is still a `datetime` or has
    already come back as a wire string (folded fields do; a real Honcho's own
    JSON response would too). Performs no precision rounding itself -- it
    relies on `wire.to_wire_timestamp` refusing a sub-millisecond `datetime`
    outright (see that function), so by the time a value reaches here both
    sides are always already millisecond-clean."""

    if a is None or b is None:
        return a is None and b is None
    return _parse_ts(a) == _parse_ts(b)


def _normalized_configuration(raw: Any) -> dict[str, Any]:
    """The INPUT side of a workspace/session `configuration` comparison, shaped
    the same way `apply_workspace_configuration_shape` predicts stock Honcho
    will actually store and return it -- comparing the raw input value would
    always disagree wherever a reserved sub-key gets dropped, which is
    declared lossy (`bundle.LOSSY_FIELDS_BY_CONSTRUCTION`), not a real
    difference to report."""

    return apply_workspace_configuration_shape(_parse_json_metadata(raw))


# ---------------------------------------------------------------------------
# Reverse adapter: Honcho's own read-back -> the same Tier1Bundle shape
# ---------------------------------------------------------------------------


def honcho_to_bundle(export: HonchoExport, workspace_name: str) -> Tier1Bundle:
    """Unfold `metadata['_v4']`, decode every Honcho resource id back to its
    v4 name, and reshape into the SAME `Tier1Bundle` dict shape v4 rows use --
    so `diff_against_input` compares like with like instead of two different
    row shapes field-by-field by hand."""

    ws = export.workspace
    workspaces = [{
        "name": names.decode_honcho_name(ws["id"]),
        "h_metadata": dict(ws.get("metadata") or {}),
        "configuration": dict(ws.get("configuration") or {}),
        "created_at": _parse_ts(ws.get("created_at")),
    }]

    peers = [
        {
            "name": names.decode_honcho_name(p["id"]),
            "workspace_name": workspace_name,
            "h_metadata": dict(p.get("metadata") or {}),
            "configuration": dict(p.get("configuration") or {}),
            "created_at": _parse_ts(p.get("created_at")),
        }
        for p in export.peers
    ]

    sessions = [
        {
            "name": names.decode_honcho_name(s["id"]),
            "workspace_name": workspace_name,
            "is_active": s.get("is_active"),
            "h_metadata": dict(s.get("metadata") or {}),
            "configuration": dict(s.get("configuration") or {}),
            "created_at": _parse_ts(s.get("created_at")),
        }
        for s in export.sessions
    ]

    session_peers = [
        {"workspace_name": workspace_name, "session_name": session_name, "peer_name": names.decode_honcho_name(peer_id)}
        for session_name, peer_ids in export.session_peers.items()
        for peer_id in peer_ids
    ]

    messages = []
    for m in export.messages:
        metadata = dict(m.get("metadata") or {})
        folded = metadata.pop(FOLD_KEY, {})
        messages.append({
            "public_id": m.get("id"),
            "workspace_name": workspace_name,
            "session_name": names.decode_honcho_name(m["session_id"]),
            "peer_name": names.decode_honcho_name(m["peer_id"]),
            "content": m["content"],
            "token_count": m.get("token_count"),
            "h_metadata": metadata,
            "created_at": _parse_ts(m.get("created_at")),
            "role": folded.get("role"),
            "in_reply_to": folded.get("in_reply_to"),
            "read": folded.get("read"),
            "read_at": folded.get("read_at"),
        })

    return Tier1Bundle(workspaces=workspaces, peers=peers, sessions=sessions, session_peers=session_peers, messages=messages)


# ---------------------------------------------------------------------------
# diff_against_input
# ---------------------------------------------------------------------------


@dataclass
class DiffReport:
    problems: list[str] = field(default_factory=list)
    lossy_fields_confirmed: set[tuple[str, str]] = field(default_factory=set)
    lossy_fields_by_construction: set[tuple[str, str]] = field(default_factory=set)
    # Facts that are neither a match nor a problem -- a documented, expected
    # CONSEQUENCE of a declared lossy field (e.g. a departed peer stays an
    # active member). See `bundle.export_to_honcho`'s docstring.
    declared_notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


def _check_row_columns(table: str, input_row: dict[str, Any], handled: dict[str, tuple[Any, Any, bool]], skip: set[str], report: DiffReport) -> None:
    """*handled*: column -> (input value, returned value, must_equal). Every
    OTHER key on *input_row* (not in `handled` or `skip`) must be declared in
    `bundle.LOSSY_FIELDS` -- anything else is an unknown column, reported as a
    problem rather than silently dropped."""

    for key, (in_val, out_val, must_equal) in handled.items():
        if must_equal and in_val != out_val:
            report.problems.append(f"{table}.{key}: {in_val!r} != {out_val!r}")

    for key in set(input_row) - set(handled) - skip:
        lossy = LOSSY_INDEX.get((table, key))
        if lossy is None:
            report.problems.append(f"{table}.{key}: unknown column -- not declared in LOSSY_FIELDS and not compared by diff_against_input")
            continue
        if _has_value(input_row.get(key)):
            report.lossy_fields_confirmed.add((table, key))


def _diff_workspace(input_bundle: Tier1Bundle, returned_bundle: Tier1Bundle, report: DiffReport) -> None:
    if not input_bundle.workspaces:
        report.problems.append("workspaces: the input bundle has no workspace row")
        return
    if not returned_bundle.workspaces:
        report.problems.append("workspaces: Honcho's export has no workspace row")
        return
    iw, ow = input_bundle.workspaces[0], returned_bundle.workspaces[0]
    handled = {
        "name": (iw["name"], ow["name"], True),
        "h_metadata": (_parse_json_metadata(iw.get("h_metadata")), ow.get("h_metadata") or {}, True),
        # Compared directly, not left to `_check_row_columns` -- a column
        # declared lossy "by construction" (see LOSSY_FIELDS_BY_CONSTRUCTION)
        # still has a real expected value once `apply_workspace_configuration_
        # shape` normalizes the reserved-key collision away; leaving it to
        # fall through as an unconditionally-lossy column would let a target
        # that drops the WHOLE column (not just a reserved sub-key) pass
        # silently -- 2026-09-26 fix-round finding, probe P4.
        "configuration": (_normalized_configuration(iw.get("configuration")), ow.get("configuration") or {}, True),
    }
    _check_row_columns("workspaces", iw, handled, set(), report)


def _diff_peers(input_bundle: Tier1Bundle, returned_bundle: Tier1Bundle, report: DiffReport) -> None:
    ins = {p["name"]: p for p in input_bundle.peers}
    outs = {p["name"]: p for p in returned_bundle.peers}
    missing = set(ins) - set(outs)
    extra = set(outs) - set(ins)
    if missing:
        report.problems.append(f"peers: missing from Honcho after import: {sorted(missing)}")
    if extra:
        report.problems.append(f"peers: present in Honcho but not in the input bundle: {sorted(extra)}")
    for name in sorted(set(ins) & set(outs)):
        ip, op = ins[name], outs[name]
        handled = {
            "name": (ip["name"], op["name"], True),
            "workspace_name": (ip["workspace_name"], op["workspace_name"], True),
            "h_metadata": (_parse_json_metadata(ip.get("h_metadata")), op.get("h_metadata") or {}, True),
            # NOT lossy (see bundle.LOSSY_FIELDS' 2026-09-26 correction):
            # PeerSpec.configuration is `dict[str, Any] | None` with no typed
            # sub-schema at all -- an arbitrary value must come back exactly.
            "configuration": (_parse_json_metadata(ip.get("configuration")), op.get("configuration") or {}, True),
        }
        _check_row_columns("peers", ip, handled, set(), report)


def _diff_sessions(input_bundle: Tier1Bundle, returned_bundle: Tier1Bundle, report: DiffReport) -> None:
    ins = {s["name"]: s for s in input_bundle.sessions}
    outs = {s["name"]: s for s in returned_bundle.sessions}
    missing = set(ins) - set(outs)
    extra = set(outs) - set(ins)
    if missing:
        report.problems.append(f"sessions: missing from Honcho after import: {sorted(missing)}")
    if extra:
        report.problems.append(f"sessions: present in Honcho but not in the input bundle: {sorted(extra)}")
    for name in sorted(set(ins) & set(outs)):
        i, o = ins[name], outs[name]
        handled = {
            "name": (i["name"], o["name"], True),
            "workspace_name": (i["workspace_name"], o["workspace_name"], True),
            "h_metadata": (_parse_json_metadata(i.get("h_metadata")), o.get("h_metadata") or {}, True),
            # Same reasoning as `_diff_workspace`'s "configuration" entry --
            # SessionConfiguration has the same reserved-key shape.
            "configuration": (_normalized_configuration(i.get("configuration")), o.get("configuration") or {}, True),
        }
        _check_row_columns("sessions", i, handled, set(), report)


def _diff_session_peers(input_bundle: Tier1Bundle, returned_bundle: Tier1Bundle, report: DiffReport) -> None:
    expected: dict[str, set[str]] = {}
    for sp in input_bundle.session_peers:
        expected.setdefault(sp["session_name"], set()).add(sp["peer_name"])
        for key in set(sp) - {"workspace_name", "session_name", "peer_name"}:
            lossy = LOSSY_INDEX.get(("session_peers", key))
            if lossy is None:
                report.problems.append(f"session_peers[{sp['session_name']}/{sp['peer_name']}].{key}: unknown column -- not declared in LOSSY_FIELDS and not compared")
                continue
            if _has_value(sp.get(key)):
                report.lossy_fields_confirmed.add(("session_peers", key))

    actual: dict[str, set[str]] = {}
    for sp in returned_bundle.session_peers:
        actual.setdefault(sp["session_name"], set()).add(sp["peer_name"])

    for session_name, want in expected.items():
        got = actual.get(session_name, set())
        if want != got:
            report.problems.append(f"session_peers[{session_name}]: expected members {sorted(want)}, Honcho has {sorted(got)}")


def _diff_one_message(im: dict[str, Any], om: dict[str, Any], position: int, session_name: str, report: DiffReport) -> None:
    where = f"messages[{session_name}][{position}]"

    if im["peer_name"] != om["peer_name"]:
        report.problems.append(f"{where}.peer_name: {im['peer_name']!r} != {om['peer_name']!r}")
    if im["content"] != om["content"]:
        report.problems.append(f"{where}.content: {im['content']!r} != {om['content']!r}")
    if not _ts_equal(im.get("created_at"), om.get("created_at")):
        report.problems.append(f"{where}.created_at: {im.get('created_at')!r} != {om.get('created_at')!r}")

    want_h = _parse_json_metadata(im.get("h_metadata"))
    got_h = dict(om.get("h_metadata") or {})
    if want_h != got_h:
        report.problems.append(f"{where}.h_metadata: {want_h!r} != {got_h!r}")

    for f in FOLDED_V4_MESSAGE_FIELDS:
        want, got = im.get(f), om.get(f)
        if want is None and got is None:
            continue
        ok = _ts_equal(want, got) if f == "read_at" else want == got
        if not ok:
            report.problems.append(f"{where}.{f} (folded): sent {want!r}, got back {got!r}")
        report.lossy_fields_confirmed.add(("messages", f))

    handled_keys = {"peer_name", "content", "created_at", "h_metadata", *FOLDED_V4_MESSAGE_FIELDS}
    skip_keys = {"workspace_name", "session_name", "seq_in_session"}
    for key in set(im) - handled_keys - skip_keys:
        lossy = LOSSY_INDEX.get(("messages", key))
        if lossy is None:
            report.problems.append(f"{where}.{key}: unknown column -- not declared in LOSSY_FIELDS and not compared")
            continue
        if _has_value(im.get(key)):
            report.lossy_fields_confirmed.add(("messages", key))


def _diff_messages(input_bundle: Tier1Bundle, returned_bundle: Tier1Bundle, report: DiffReport) -> None:
    """Positional, per-session comparison -- v4's `public_id` is never sent
    to Honcho at all (see LOSSY_FIELDS), so identity can only be order within
    a session, which is exactly what issue #8 repro D found was never
    checked. `seq_in_session` itself is not compared column-by-column; this
    positional pairing IS the seq-order check."""

    ins_by_session: dict[str, list[dict[str, Any]]] = {}
    for m in sorted(input_bundle.messages, key=lambda m: (m["session_name"], m["seq_in_session"])):
        ins_by_session.setdefault(m["session_name"], []).append(m)

    outs_by_session: dict[str, list[dict[str, Any]]] = {}
    for m in returned_bundle.messages:  # already in Honcho's own return order
        outs_by_session.setdefault(m["session_name"], []).append(m)

    for session_name in sorted(set(ins_by_session) | set(outs_by_session)):
        ins = ins_by_session.get(session_name, [])
        outs = outs_by_session.get(session_name, [])
        if len(ins) != len(outs):
            report.problems.append(f"messages[{session_name}]: {len(ins)} sent vs {len(outs)} returned -- a message was dropped, duplicated, or landed in the wrong session")
        for position, (im, om) in enumerate(zip(ins, outs)):
            _diff_one_message(im, om, position, session_name, report)


def diff_against_input(input_bundle: Tier1Bundle, returned_bundle: Tier1Bundle) -> DiffReport:
    """The claim SPEC §15.5 actually makes: does a round trip through Honcho
    reproduce *input_bundle*, field for field, except where `bundle.LOSSY_FIELDS`
    says it cannot? *returned_bundle* is normally `honcho_to_bundle(export, ...)`."""

    report = DiffReport()
    report.lossy_fields_by_construction |= LOSSY_FIELDS_BY_CONSTRUCTION

    _diff_workspace(input_bundle, returned_bundle, report)
    _diff_peers(input_bundle, returned_bundle, report)
    _diff_sessions(input_bundle, returned_bundle, report)
    _diff_session_peers(input_bundle, returned_bundle, report)
    _diff_messages(input_bundle, returned_bundle, report)

    for sp in input_bundle.session_peers:
        if sp.get("left_at") is not None:
            report.declared_notes.append(
                f"session_peers[{sp['session_name']}/{sp['peer_name']}]: left_at={sp['left_at']!r} in v4, but "
                "this harness makes no call to Honcho's own DELETE .../sessions/{id}/peers -- a deliberate policy "
                "choice ('reproduce v4's history' vs 'reproduce v4's current state'), not an API limitation -- so "
                "the peer remains an ACTIVE member of the session after import. Declared, not a bug: see "
                "bundle.LOSSY_FIELDS session_peers.left_at and export_to_honcho's docstring."
            )

    return report
