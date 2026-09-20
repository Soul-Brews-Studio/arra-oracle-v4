set shell := ["bash", "-uc"]

root := source_directory() / ".."
data := root / "data"

# SmooSense (Apache-2.0) -- database browser: schema, indices, versions, SQL over DuckDB.
# Installed as an isolated uv tool, so its lancedb pin never touches the app's.
sense port="8123":
    uvx --from smoosense sense db {{data}} --port {{port}}

# Same tool, folder mode -- browses the .lance directory as files
sense-folder port="8123":
    uvx --from smoosense sense folder {{data}} --port {{port}}

install-sense:
    uv tool install -U smoosense

# lance-data-viewer (MIT) -- read-only web UI, Docker only.
# NOTE: newest published image is lancedb-0.36.0; this data is written by 0.38.0,
# so a format-version mismatch is the expected failure. Needs a running daemon.
viewer tag="lancedb-0.36.0" port="8080":
    @docker ps >/dev/null 2>&1 || { echo "docker daemon is down — 'colima start' first"; exit 1; }
    docker pull ghcr.io/lance-format/lance-data-viewer:{{tag}}
    docker run --rm -p {{port}}:8080 -v {{data}}:/data:ro ghcr.io/lance-format/lance-data-viewer:{{tag}}

# The app's own UI
ui port="3939":
    @open http://127.0.0.1:{{port}} 2>/dev/null || echo "http://127.0.0.1:{{port}}"
