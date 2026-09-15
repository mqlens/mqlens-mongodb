#!/usr/bin/env bash
# Refreshes everything the desktop takes from MQLens Server:
#
#   src-tauri/proto/mqlens/v1/*.proto          verbatim copy of the server's protos
#   src-tauri/proto/SOURCE                     the server commit they came from
#   src-tauri/src/server/pb/mqlens/            Rust client generated from them
#   src-tauri/src/server/testdata/server_ejson_fixture.jsonl
#                                              Extended JSON golden corpus
#
# Usage: scripts/refresh-server-protos.sh [path-to-mqlens-server-checkout]
# The server checkout defaults to ../mqlens-server next to this repository.
# Needs git, buf (remote plugins, so no protoc) and go.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
server="${1:-$repo_root/../mqlens-server}"
server="$(cd "$server" && pwd)"
tauri="$repo_root/src-tauri"

if [ ! -d "$server/proto/mqlens/v1" ]; then
  echo "error: $server does not look like an mqlens-server checkout (no proto/mqlens/v1)" >&2
  exit 1
fi
for tool in git buf go; do
  command -v "$tool" >/dev/null || { echo "error: $tool is required" >&2; exit 1; }
done

commit="$(git -C "$server" rev-parse HEAD)"
if [ -n "$(git -C "$server" status --porcelain -- proto internal/proxy)" ]; then
  echo "warning: $server has uncommitted changes under proto/ or internal/proxy/;" >&2
  echo "         proto/SOURCE will name $commit, which does not contain them" >&2
fi

echo "Copying protos from $server ($commit)"
rm -f "$tauri"/proto/mqlens/v1/*.proto
mkdir -p "$tauri/proto/mqlens/v1"
cp "$server"/proto/mqlens/v1/*.proto "$tauri/proto/mqlens/v1/"
cat > "$tauri/proto/SOURCE" <<EOF
These .proto files are a verbatim copy of proto/ from MQLens Server
(https://github.com/mqlens/mqlens-server). Do not edit them here: change them
in the server repository, then refresh this copy and the generated client with
scripts/refresh-server-protos.sh.

repository: https://github.com/mqlens/mqlens-server
commit: $commit
EOF

echo "Generating the Rust client"
rm -rf "$tauri/src/server/pb/mqlens"
(cd "$tauri" && buf generate)

echo "Writing the Extended JSON fixture"
mkdir -p "$tauri/src/server/testdata"
fixture="$tauri/src/server/testdata/server_ejson_fixture.jsonl"
if command -v cygpath >/dev/null; then fixture="$(cygpath -w "$fixture")"; fi
MQLENS_WRITE_EJSON_FIXTURE="$fixture" \
  go -C "$server" test ./internal/proxy -run '^TestWriteEJSONFixture$' -count=1 >/dev/null

echo "Done. Review the diff, then run: cargo test --manifest-path src-tauri/Cargo.toml --lib server::"
