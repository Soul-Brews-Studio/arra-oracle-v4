"""Write (or reuse) a local-dev auth policy file, `arra-auth/v1` shape.

Matches the format `app/server/src/auth/policy.ts` parses and
`app/server/test/helpers/auth-fixture.ts` already exercises in tests: one
principal, one credential, granting every workspace action on a single
workspace.

The token secret is generated ONCE and cached at `<out_dir>/dev-token.txt` so
repeated runs of the dev stack keep serving the same bearer token instead of
invalidating it on every restart. `loadPolicy` (auth/loader.ts) requires the
policy file to be owned by the current uid with no group/other bits, so both
files are written with mode 0600.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sys


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: write_dev_policy.py <out_dir> <workspace> <principal_id>", file=sys.stderr)
        return 2
    out_dir, workspace, principal_id = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)

    token_path = os.path.join(out_dir, "dev-token.txt")
    if os.path.exists(token_path):
        secret = open(token_path, encoding="utf-8").read().strip()
    else:
        secret = secrets.token_hex(32)  # 64 lowercase hex chars, matches BEARER_PATTERN
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(secret + "\n")

    digest = hashlib.sha256(secret.encode("ascii")).hexdigest()

    document = {
        "version": "arra-auth/v1",
        "principals": [
            {
                "id": principal_id,
                "disabled": False,
                "workspaces": [
                    {
                        "name": workspace,
                        "actions": ["content:read", "content:write", "audit:read", "diagnostics:read"],
                    }
                ],
                "global_actions": [],
            }
        ],
        "credentials": [
            {
                "id": "cred-dev",
                "principal_id": principal_id,
                "sha256": digest,
                "not_before": "2026-01-01T00:00:00.000Z",
                "expires_at": "2030-01-01T00:00:00.000Z",
                "revoked": False,
            }
        ],
    }

    policy_path = os.path.join(out_dir, "dev-policy.json")
    fd = os.open(policy_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(document))
    # os.open's mode is masked by umask; force it explicitly (loadPolicy checks 0o077 clear).
    os.chmod(policy_path, 0o600)
    os.chmod(token_path, 0o600)

    print(f"policy: {policy_path}")
    print(f"token:  {secret}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
