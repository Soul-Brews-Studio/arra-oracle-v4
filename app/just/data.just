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

# LanceDB against S3. `just data s3probe` = local moto; `just data s3probe r2` = R2.
# R2 needs R2_ACCOUNT_ID + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY exported;
# wrangler cannot mint the key, it is a dashboard token (R2 > API > Manage API tokens).
s3probe target="local":
    cd {{source_directory()}}/../migrate-py && S3_TARGET={{target}} uv run arra-s3probe

# A throwaway local S3 on :5555, so s3probe runs with no credentials at all.
moto:
    uv run --with 'moto[server]' moto_server -p 5555

# Where the dataset lives right now. Local unless ARRA_DATA_DIR says otherwise.
store:
    @curl -s http://127.0.0.1:{{env_var_or_default("PORT","3939")}}/api/health \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['db']['storage'])"
