"""Launch the arra-oracle-v4 server as the SOLE writer of a target19 dataset.

`app/server/src/publication/storage.ts`'s `assertInheritedGate` refuses to
open a knowledge writer unless it was handed fd 42, flocked, pointing at
`<dataset_root>/.arra-writer.lock` -- proven by descriptor identity (uid,
mode 0600, nlink, inode), not merely by the `ARRA_WRITER_FD`/`ARRA_WRITER_ROOT`
env vars naming it. `arra_migrate.writer_gate.exec_with_gate` is the one
function in the repo that sets this up correctly: it takes the flock, dup2s
it onto fd 42, sets both env vars, and REPLACES this process with `bun run
src/index.ts` via execvpe -- so the Bun process that ends up serving requests
is the same process that acquired the lock, with fd 42 still open and held
for its entire lifetime.

All other env (ARRA_AUTH_POLICY, ARRA_ORIGIN, PORT, ARRA_DATA_DIR,
ARRA_KNOWLEDGE_DATASET_ROOT) is expected to already be exported by the caller
(`dev-stack.sh`) -- this script adds the writer-gate pair on top of
`os.environ` and never returns on success.

One dev default (#32, overnight ruling R9, docs/overnight/DECISIONS.md): the
local dev server answers chat with the LOCAL Ollama, so `ARRA_CHAT_PROVIDER`
defaults to `ollama` here (model gemma3:4b, at ARRA_CHAT_URL, else OLLAMA_URL,
else 127.0.0.1:11434). An exported value -- including an empty one, which
means "unconfigured" -- always wins. `bun src/index.ts` on its own stays
unconfigured (answerChat answers `model_unavailable`) unless told otherwise.
"""

from __future__ import annotations

import os
import sys

from arra_migrate.writer_gate import exec_with_gate


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: run_dev_server.py <dataset_root> <server_dir>", file=sys.stderr)
        return 2
    dataset_root, server_dir = sys.argv[1], sys.argv[2]

    # bun's `public` asset dir and relative ARRA_DATA_DIR ("../data") are both
    # resolved against cwd, matching how `just server start` runs it.
    os.chdir(server_dir)

    os.environ.setdefault("ARRA_CHAT_PROVIDER", "ollama")
    exec_with_gate(dataset_root, ["bun", "run", "src/index.ts"])
    # Unreachable on success -- execvpe replaced this process.
    print("EXEC_FAILED", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
