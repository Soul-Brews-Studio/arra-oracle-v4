"""The pinned, disposable target for the §15.5 round trip. Issue #8.

The issue's own 2026-09-20 scope correction rules out the previously assumed
target: the self-hosted instance on ``white.local:8000`` is shared, mutable,
unauthenticated-to-touch, and its Postgres volume has already been wiped
once (2026-08-13). A round trip against it proves nothing reproducible -- if
it drifts between the export leg and the import leg, the test silently
changes what it means. That correction also revokes any assumption that a
reachable Honcho MCP endpoint is evidence of a writable, isolated test
instance.

So the target here is defined structurally, the same way issue #34's
migration rehearsal defines its source: as data plus config that a harness
constructs and destroys, never as "whatever is already running". This
module is that definition. IT DOES NOT START ANYTHING -- see
``docker/README.md`` next to this file for the (manual, human-run) steps
that would actually bring it up, and ``target.HttpHonchoTarget`` for the
client that would talk to it if it existed.

## Why pinned by git ref, not a registry image tag

Honcho's own ``docker-compose.yml.example`` (plastic-labs/honcho, ``main``,
fetched 2026-09-21) builds the API image from the repo's root ``Dockerfile``
rather than pulling a published tag, and no versioned image was found under
a container registry for this project at the time of writing. A git ref is
therefore the reproducible unit that actually exists, not one invented for
this issue.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass(frozen=True)
class HonchoPin:
    """Version AND config, together -- either one alone is not a pin."""

    repo_url: str
    git_ref: str
    commit_sha: str  # `git rev-parse <git_ref>^{commit}` at the time this was written
    env: dict[str, str] = field(default_factory=dict)
    bind_host: str = "127.0.0.1"
    port: int = 8000
    api_prefix: str = "/v3"  # confirmed: src/main.py mounts every router under this prefix


# Verified 2026-09-21 via `gh api repos/plastic-labs/honcho/tags` (tag exists,
# resolves to this commit) and by reading api.py/routers/*.py AT this ref --
# every route and schema field name `target.py` and `bundle.py` rely on was
# read from the file at this exact ref, not from memory or the `main` branch.
HONCHO_V3_2_0 = HonchoPin(
    repo_url="https://github.com/plastic-labs/honcho.git",
    git_ref="v3.2.0",
    commit_sha="210b56cf953fcf447ffafcb428d4b4f1823b83fd",
    env={
        # AUTH off -- matches the issue's stated deployment style, and removes
        # a JWT-provisioning step that is irrelevant to what this test proves.
        "AUTH_USE_AUTH": "false",
        # Disposable Postgres, brought up by the SAME compose file, never the
        # shared white.local volume. Passwordless trust auth, matching
        # Honcho's own docker-compose.yml.example for local/dev use.
        "DB_CONNECTION_URI": "postgresql+psycopg://postgres:postgres@database:5432/postgres",
        # The deriver/dreamer/LLM-backed reasoning paths are OUT of the SPEC
        # §15 tier-1 scope this issue tests (workspaces/peers/sessions/
        # session_peers/messages only) and require a working LLM credential
        # this harness has no business holding. Disabled so an LLM call
        # succeeding or failing can never perturb the tier-1 CRUD round trip
        # this test measures. If a future issue extends scope to
        # conclusions/representations, the deriver needs to be turned back on
        # and `structured_output_mode=json_object` revisited explicitly --
        # do not assume this pin still applies unchanged.
        #
        # NOT `DERIVER_WORKERS=0` -- an earlier version of this pin set that,
        # which fails Honcho's own `WORKERS: Field(default=1, gt=0, le=100)`
        # (`src/config.py`) at `AppSettings()` import time, so the api
        # container would never even boot. `DERIVER_ENABLED` is the actual
        # on/off switch (`src/config.py`); confirmed 2026-09-26 against the
        # pinned commit, not carried over from the earlier, unverified value.
        "DERIVER_ENABLED": "false",
        # Background embedding defaults to ON (`EMBED_MESSAGES`, `src/config.py`)
        # and is not implied by `DERIVER_ENABLED` -- left on, a boot with no
        # LLM/embedding credential would still try to reach an external
        # provider on every message create.
        "EMBED_MESSAGES": "false",
    },
)


class NotALoopbackTargetError(ValueError):
    """`HONCHO_ROUNDTRIP_LIVE_BASE_URL` does not point at a loopback address."""


def require_loopback_url(base_url: str) -> None:
    """Refuse any live-leg target whose host is not loopback.

    A bare substring check for ``"white.local"`` (the specific shared instance
    issue #8's 2026-09-20 scope correction named) only catches that one
    hostname -- a cloud Honcho, a teammate's machine, or a typo'd hostname
    would all sail through unchecked and receive real writes. The scope
    correction's actual rule is narrower than "not white.local": this harness
    only ever writes to a throwaway instance IT stood up, which by
    construction is always reachable on loopback (``pin.HonchoPin.bind_host``
    is ``127.0.0.1``) -- so loopback-only is the direct enforcement of that
    rule, not a new one invented here.
    """

    host = urlparse(base_url).hostname
    if host is None:
        raise NotALoopbackTargetError(f"{base_url!r} has no parseable host")
    if host == "localhost":
        return
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        raise NotALoopbackTargetError(
            f"{base_url!r} must point at a loopback address (127.0.0.1 or localhost), not {host!r} -- "
            "issue #8's 2026-09-20 scope correction rules out any shared or remote Honcho instance"
        ) from None
    if not ip.is_loopback:
        raise NotALoopbackTargetError(
            f"{base_url!r} must point at a loopback address (127.0.0.1 or localhost), not {host!r} -- "
            "issue #8's 2026-09-20 scope correction rules out any shared or remote Honcho instance"
        )
