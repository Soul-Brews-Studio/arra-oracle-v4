"""Direct copy of legacy ``vocabularies`` and ``terms`` (ruling R17).

Legacy vocabularies carry no policy columns, so every one is backfilled with
the ruled policy: ``cardinality: many``, ``required: false``, ``hierarchy: flat``.

FLAT means no parents. The kernel reads a non-null stored ``parent_id`` in a
flat vocabulary as corruption (taxonomy-write-v1 ``reparentTerm``;
``service.reparentTerm.ts``: ``integrity_failure``, and no API can repair it),
so a legacy ``terms.parent_id`` is NEVER stored: the term migrates with
``parent_id`` NULL and the legacy parent is a ``terms.parent_id`` pointer
record (``unresolved`` / ``parent_dropped_flat_hierarchy``) naming the legacy
and the mapped target id. The source keeps it. This invariant spans rows, so
the per-row codecs cannot see it; ``verify.taxonomy_problems`` checks it.

Names the target reserves are refused per record, not merged:
  - ``type`` / ``memory_horizon`` belong to the kernel's reserved seed;
  - ``legacy_type`` belongs to the R11 tag vocabulary this migration creates.

Vocabulary and term names follow the kernel's write grammar
(``taxonomy.requireName.ts``: nonempty, at most 256 UTF-8 bytes). The stored-row
codec does not re-check the bound, so a longer legacy name is rejected HERE
rather than written as a row the kernel could never have produced.

A legacy vocabulary named like an R18 D2 adapter vocabulary (``concepts``,
``project``) is copied with its own policy -- loosening a sealed vocabulary is
not ruled -- but a policy the v3 adapter cannot use (it creates terms on
demand, which R6 refuses in a sealed vocabulary) is flagged on its record.

A term whose vocabulary did not migrate is UNRESOLVED with a record -- the
old rehearsal raised ``KeyError`` there and left a partial target.
"""

from __future__ import annotations

import math
from typing import Any

from .ids import IdCollision
from .state import CopyState
from .timestamps import first_sub_ms

Row = dict[str, Any]

RESERVED_VOCABULARY_NAMES = ("type", "memory_horizon")
LEGACY_TYPE_VOCABULARY = "legacy_type"
#: R17, docs/overnight/DECISIONS.md.
LEGACY_VOCABULARY_POLICY = {"cardinality": "many", "required": False, "hierarchy": "flat"}
#: taxonomy.requireName.ts: the kernel's bound on a vocabulary or term name.
MAX_NAME_BYTES = 256
#: R18 D2 (docs/overnight/V3-PARITY.md A4): the v3 adapter's own vocabularies, open.
ADAPTER_VOCABULARY_NAMES = ("concepts", "project")


def name_too_long(name: str) -> bool:
    return len(name.encode("utf-8")) > MAX_NAME_BYTES


def copy_vocabularies(rows: list[Row], state: CopyState) -> list[Row]:
    out = []
    seen: set[tuple[str, str]] = set()
    state.report.policies["adapter_vocabulary_policy_mismatch"] += 0
    for row in rows:
        ws, key, name = row["workspace_name"], row["id"], row["name"]
        if ws not in state.workspaces:
            state.unresolved("vocabularies", key, ws, "workspace_unresolved", "/workspace_name")
            continue
        if name in RESERVED_VOCABULARY_NAMES:
            state.rejected("vocabularies", key, ws, "reserved_vocabulary_name", "/name",
                           detail=f"{name!r} is seeded by the kernel; the legacy vocabulary is not merged into it")
            continue
        if name == LEGACY_TYPE_VOCABULARY:
            state.rejected("vocabularies", key, ws, "reserved_by_migration", "/name",
                           detail="legacy_type holds R11 tags created by this migration")
            continue
        if row["kind"] not in ("tags", "categories"):
            state.rejected("vocabularies", key, ws, "invalid_value", "/kind")
            continue
        if row["term_policy"] not in ("open", "sealed"):
            state.rejected("vocabularies", key, ws, "invalid_value", "/term_policy")
            continue
        if not name or not row["label"]:
            state.rejected("vocabularies", key, ws, "invalid_value", "/name" if not name else "/label")
            continue
        if name_too_long(name):
            state.rejected("vocabularies", key, ws, "limit_exceeded", "/name",
                           detail=f"name is {len(name.encode('utf-8'))} UTF-8 bytes; the kernel allows {MAX_NAME_BYTES}")
            continue
        bad = first_sub_ms(row, ("created_at",))
        if bad is not None:
            state.rejected("vocabularies", key, ws, "sub_millisecond_timestamp", "/created_at")
            continue
        if (ws, name) in seen:
            state.rejected("vocabularies", key, ws, "duplicate_name", "/name")
            continue
        try:
            target = state.ids.assign("vocabularies", ws, key)
        except IdCollision as error:
            state.rejected("vocabularies", key, ws, "id_collision", "/id", detail=str(error))
            continue
        seen.add((ws, name))
        state.vocabularies[key] = {"workspace": ws, "id": target, "name": name}
        detail = "R17 policy many/optional/flat"
        if name in ADAPTER_VOCABULARY_NAMES and row["term_policy"] != "open":
            state.report.policies["adapter_vocabulary_policy_mismatch"] += 1
            detail += (f"; R18 D2: the v3 adapter expects {name!r} open, legacy term_policy="
                       f"{row['term_policy']!r} kept -- its on-demand term creation will be refused (R6)")
        state.migrated("vocabularies", key, ws, target, detail=detail)
        out.append({**row, "id": target, **LEGACY_VOCABULARY_POLICY})
    return out


def copy_terms(rows: list[Row], state: CopyState) -> list[Row]:
    accepted: list[Row] = []
    seen: set[tuple[str, str]] = set()
    state.report.policies["term_parent_dropped"] += 0
    for row in rows:
        key = row["id"]
        vocabulary = state.vocabularies.get(row["vocabulary_id"])
        if vocabulary is None:
            state.unresolved("terms", key, None, "vocabulary_unresolved", "/vocabulary_id",
                             detail=f"legacy vocabulary_id={row['vocabulary_id']!r} did not migrate")
            continue
        ws = vocabulary["workspace"]
        if not row["name"]:
            state.rejected("terms", key, ws, "invalid_value", "/name")
            continue
        if name_too_long(row["name"]):
            state.rejected("terms", key, ws, "limit_exceeded", "/name",
                           detail=f"name is {len(row['name'].encode('utf-8'))} UTF-8 bytes; the kernel allows {MAX_NAME_BYTES}")
            continue
        if not isinstance(row["weight"], float) or not math.isfinite(row["weight"]):
            state.rejected("terms", key, ws, "invalid_value", "/weight")
            continue
        if first_sub_ms(row, ("created_at",)) is not None:
            state.rejected("terms", key, ws, "sub_millisecond_timestamp", "/created_at")
            continue
        if (row["vocabulary_id"], row["name"]) in seen:
            state.rejected("terms", key, ws, "duplicate_name", "/name")
            continue
        try:
            target = state.ids.assign("terms", ws, key)
        except IdCollision as error:
            state.rejected("terms", key, ws, "id_collision", "/id", detail=str(error))
            continue
        seen.add((row["vocabulary_id"], row["name"]))
        state.terms[key] = {
            "workspace": ws, "id": target, "name": row["name"],
            "vocabulary_id": vocabulary["id"], "vocabulary_name": vocabulary["name"],
        }
        accepted.append(row)

    out = []
    for row in accepted:
        term = state.terms[row["id"]]
        parent = row["parent_id"]
        if parent is not None:
            # Every migrated vocabulary is flat (R17): no parent is ever stored.
            state.report.policies["term_parent_dropped"] += 1
            candidate = state.terms.get(parent)
            if candidate is not None and candidate["vocabulary_id"] == term["vocabulary_id"]:
                state.pointer("terms.parent_id", row["id"], term["workspace"], False,
                              code="parent_dropped_flat_hierarchy",
                              detail=f"legacy parent_id={parent!r} (target {candidate['id']!r}) not stored: "
                                     "R17 hierarchy flat, and the kernel refuses a stored parent there")
            else:
                state.pointer("terms.parent_id", row["id"], term["workspace"], False,
                              code="parent_unresolved",
                              detail=f"legacy parent_id={parent!r} did not migrate into this vocabulary")
        state.migrated("terms", row["id"], term["workspace"], term["id"])
        out.append({
            "id": term["id"], "workspace_name": term["workspace"], "vocabulary_id": term["vocabulary_id"],
            "name": row["name"], "description": row["description"], "parent_id": None,
            "weight": row["weight"], "is_active": True, "h_metadata": row["h_metadata"],
            "created_at": row["created_at"],
        })
    return out
