set shell := ["bash", "-uc"]

root := source_directory() / ".."
py   := root / "migrate-py"
rs   := root / "migrate-rs"

# R32 (docs/overnight/DECISIONS.md): the default registry is target-19.
# Create any target-19 table absent on disk. Safe to re-run.
run:
    cd {{py}} && uv run arra-migrate

# Does the table on disk still match the target-19 registry? Exits 1 on drift.
check:
    cd {{py}} && uv run arra-migrate --check

# Recreate. Old versions stay on disk -- Lance deletes nothing.
reset:
    cd {{py}} && ARRA_RESET=1 uv run arra-migrate

# The legacy 15 (memories tier), only for the legacy /api/memories routes.
run-legacy:
    cd {{py}} && uv run arra-migrate --legacy-active15

check-legacy:
    cd {{py}} && uv run arra-migrate --legacy-active15 --check

# Print the declared target-19 schema without touching any data
models:
    @cd {{py}} && uv run python -c "from arra_migrate.target_v1 import TARGET_TABLES; [print(n, '\n ', m.to_arrow_schema()) for n, m in TARGET_TABLES.items()]"

# Print the declared legacy-15 schema without touching any data
models-legacy:
    @cd {{py}} && uv run python -c "from arra_migrate.models import TABLES; [print(n, '\n ', m.to_arrow_schema()) for n, m in TABLES.items()]"

# --- retained, no longer the owner -------------------------------------------
# The Rust migration that came first. Kept because it is the record of how the
# schema was established, and because it proves the format is language-neutral:
# `rs-run` and `run` produce the same 18 fields. 8.1 GB of build artifacts for
# 72 lines is why it is not the default.
rs-build:
    cargo build --manifest-path {{rs}}/Cargo.toml

rs-run: rs-build
    cd {{rs}} && cargo run --quiet
