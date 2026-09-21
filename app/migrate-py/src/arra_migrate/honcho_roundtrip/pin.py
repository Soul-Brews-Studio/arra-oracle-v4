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

from dataclasses import dataclass, field


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
        # this harness has no business holding. Left unset/disabled so an
        # LLM call succeeding or failing can never perturb the tier-1 CRUD
        # round trip this test measures. If a future issue extends scope to
        # conclusions/representations, the deriver needs to be turned back on
        # and `structured_output_mode=json_object` revisited explicitly --
        # do not assume this pin still applies unchanged.
        "DERIVER_WORKERS": "0",
    },
)
