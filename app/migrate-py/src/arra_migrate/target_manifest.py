"""Validation for the proposed target manifest; never creates tables."""

from collections.abc import Mapping
from typing import Any


def validate_target_manifest(value: Mapping[str, Any]) -> dict[str, Any]:
    required = {"manifest_version", "status", "authority", "current_registry_tables", "target_tables", "target_count", "deferred"}
    if not isinstance(value, Mapping) or set(value) != required:
        raise ValueError("target manifest keys are not the closed v1 set")
    if value["status"] != "proposed-not-active" or value["target_count"] != 19:
        raise ValueError("target manifest is not the proposed 19-table contract")
    current = value["current_registry_tables"]
    target = value["target_tables"]
    deferred = value["deferred"]
    if not all(isinstance(items, list) and all(isinstance(item, str) and item for item in items) for items in (current, target, deferred)):
        raise ValueError("manifest lists must contain nonempty strings")
    if len(current) != 15 or len(set(current)) != 15:
        raise ValueError("active registry must contain exactly 15 distinct tables")
    if len(target) != 19 or len(set(target)) != 19:
        raise ValueError("target must contain exactly 19 distinct tables")
    # The target intentionally replaces legacy `memories`/`memory_terms` with
    # node/revision tables; every other active lane must remain represented.
    preserved = set(current) - {"memories", "memory_terms"}
    if not preserved <= set(target) or set(target) == set(current):
        raise ValueError("target must preserve active lanes and explicitly replace legacy memory tables")
    if not deferred:
        raise ValueError("unresolved gates must remain visible")
    return dict(value)
