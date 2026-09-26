"""The shape stock Honcho actually stores for workspace/session configuration.

Issue #8, ruling R15 fix round. `WorkspaceConfiguration`/`SessionConfiguration`
(`schemas/configuration.py:117`, pinned commit `pin.HONCHO_V3_2_0`) both have
`model_config = ConfigDict(extra="allow")` -- an arbitrary top-level key
round-trips untouched -- but type their four RESERVED sub-schema names
(`reasoning`, `peer_card`, `summary`, `dream`) as nested `BaseModel`s, whose
default pydantic behaviour is to ignore, not preserve, a sub-key the nested
model does not itself declare. `crud.get_or_create_workspace` stores
`configuration.model_dump(exclude_none=True)` -- this function is that same
transform, applied to a plain dict.

Shared, not duplicated, between the two places that both need Honcho's real
answer to "what does this configuration look like after a round trip":
`target.FakeHonchoTarget` (what gets STORED) and `diff.diff_against_input`
(what the INPUT should be compared against). One function used on both sides
means a correction to the pinned schema's shape only has to be made once --
see the 2026-09-26 fix-round finding that `diff.py` was comparing the raw
input against Honcho's answer with no shape applied to either side, so any
consistent corruption of the whole column passed unnoticed.
"""

from __future__ import annotations

from typing import Any

# schemas/configuration.py: ReasoningConfiguration, PeerCardConfiguration,
# SummaryConfiguration, DreamConfiguration -- transcribed field names only,
# re-checked 2026-09-26 against the pinned commit.
CONFIG_RESERVED_FIELDS: dict[str, frozenset[str]] = {
    "reasoning": frozenset({"enabled", "custom_instructions"}),
    "peer_card": frozenset({"use", "create"}),
    "summary": frozenset({"enabled", "messages_per_short_summary", "messages_per_long_summary"}),
    "dream": frozenset({"enabled"}),
}


def apply_workspace_configuration_shape(configuration: dict[str, Any]) -> dict[str, Any]:
    """*configuration* as stock Honcho would actually store and return it: any
    top-level key outside `CONFIG_RESERVED_FIELDS` passes through untouched
    (`extra="allow"`); a dict value under one of the four reserved names keeps
    only the sub-keys that name's typed model declares. Not applied to peer
    configuration, which has no typed sub-schema at all (`PeerSpec.configuration`
    is a plain `dict[str, Any] | None`)."""

    out = dict(configuration)
    for key, allowed in CONFIG_RESERVED_FIELDS.items():
        if isinstance(out.get(key), dict):
            out[key] = {k: v for k, v in out[key].items() if k in allowed}
    return out
