set shell := ["bash", "-uc"]

root    := source_directory() / ".."
scripts := source_directory() / "scripts"
table   := env_var_or_default("ARRA_TABLE", root / "data" / "memories.lance")

# Schema straight off disk -- works with the server down
schema:
    @uv run --quiet {{scripts}}/lance_peek.py {{table}} schema

# Every committed version. Lance keeps them all; nothing is deleted.
versions:
    @uv run --quiet {{scripts}}/lance_peek.py {{table}} versions

# Rows, minus the embedding vector that would swamp a terminal
rows limit="20":
    @uv run --quiet {{scripts}}/lance_peek.py {{table}} rows {{limit}}

# Disk cost and how many manifests have accumulated
disk:
    @du -sh {{table}}
    @echo "manifests: $(ls {{table}}/_versions/*.manifest 2>/dev/null | wc -l | tr -d ' ')"
    @echo "txns:      $(ls {{table}}/_transactions/*.txn 2>/dev/null | wc -l | tr -d ' ')"
