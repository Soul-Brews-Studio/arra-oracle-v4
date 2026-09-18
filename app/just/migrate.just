set shell := ["bash", "-uc"]

root := source_directory() / ".."
crate := root / "migrate"

# Build the Rust migration binary
build:
    cargo build --manifest-path {{crate}}/Cargo.toml

# Create the table if absent (idempotent — safe to re-run)
run: build
    cd {{crate}} && cargo run --quiet

# Recreate the table. Old versions stay on disk; Lance deletes nothing.
reset: build
    cd {{crate}} && ARRA_RESET=1 cargo run --quiet

# Typecheck without producing a binary
check:
    cargo check --manifest-path {{crate}}/Cargo.toml
