set shell := ["bash", "-uc"]

root := source_directory() / ".."
srv  := root / "server"
port := env_var_or_default("PORT", "3939")

install:
    cd {{srv}} && bun install

start:
    cd {{srv}} && bun run src/index.ts

dev:
    cd {{srv}} && bun --watch src/index.ts

health:
    @curl -s http://127.0.0.1:{{port}}/api/health | python3 -m json.tool

# Write a memory through the API. Embeds inline when the embedder is up.
add name content bank="default":
    @curl -s -X POST http://127.0.0.1:{{port}}/api/memories \
      -H 'content-type: application/json' \
      -d '{"name":"{{name}}","content":"{{content}}","workspace_name":"{{bank}}"}' | python3 -m json.tool

# search QUERY [text|vector] [bank]
search q mode="text" bank="":
    @curl -s "http://127.0.0.1:{{port}}/api/search?q=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' '{{q}}')&mode={{mode}}&bank={{bank}}" | python3 -m json.tool

# Embed every row that has no vector yet
backfill batch="32":
    @curl -s -X POST "http://127.0.0.1:{{port}}/api/backfill?batch={{batch}}" | python3 -m json.tool

reindex:
    @curl -s -X POST http://127.0.0.1:{{port}}/api/reindex | python3 -m json.tool
