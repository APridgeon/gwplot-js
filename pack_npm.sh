#!/usr/bin/env bash
# Pack what build.sh installed as an npm package, for a project to install:
#
#   ./pack_npm.sh [DEST] [VERSION] [PACK_DIR]
#
#   DEST      what build.sh installed (default: out), whose manifest.json names the version
#             directory to pack
#   VERSION   the package's version (default: package.json's)
#   PACK_DIR  where to write gwplot-js-<VERSION>.tgz (default: .)
#
# The package holds the module's files flat, without build.sh's hashed directory: npm's
# version, or a bundler's own hashing, does that job. Each export has TypeScript
# declarations (the repo's *.d.mts, for builds from before build.sh installed them):
#
#   gwplot-js              gwplot.mjs, for a browser (a Web Worker)
#   gwplot-js/fs_bridge    fs_bridge.mjs
#   gwplot-js/node         gwplot.node.mjs, for Node; pass it gwplot-js/gwplot.wasm as
#                          wasmBinary (it would look for a gwplot.node.wasm, not shipped)
#   gwplot-js/gwplot.wasm  the module's WebAssembly
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$(cd "${1:-$HERE/out}" && pwd)"
VERSION="${2:-$(node -p "require('$HERE/package.json').version")}"
mkdir -p "${3:-.}"
PACK_DIR="$(cd "${3:-.}" && pwd)"

build="$(node -p "require('$DEST/manifest.json').version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for file in gwplot.mjs gwplot.wasm fs_bridge.mjs gwplot.node.mjs; do
    cp "$DEST/$build/$file" "$STAGE/"
done
for file in gwplot.d.mts gwplot.node.d.mts fs_bridge.d.mts; do
    if [ -f "$DEST/$build/$file" ]; then cp "$DEST/$build/$file" "$STAGE/"; else cp "$HERE/$file" "$STAGE/"; fi
done
cp "$HERE/README.md" "$HERE/LICENSE" "$STAGE/"

# No "type": the modules are .mjs already
VERSION="$VERSION" node -e '
const root = require(process.argv[1])
const pkg = {
  name: root.name,
  version: process.env.VERSION,
  description: root.description,
  license: root.license,
  repository: root.repository,
  exports: {
    ".": { types: "./gwplot.d.mts", default: "./gwplot.mjs" },
    "./fs_bridge": { types: "./fs_bridge.d.mts", default: "./fs_bridge.mjs" },
    "./node": { types: "./gwplot.node.d.mts", default: "./gwplot.node.mjs" },
    "./gwplot.wasm": "./gwplot.wasm",
  },
}
require("fs").writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n")
' "$HERE/package.json" "$STAGE/package.json"

(cd "$STAGE" && npm pack --silent --pack-destination "$PACK_DIR" >/dev/null)
echo "gwplot-js $VERSION (build $build) is in $PACK_DIR/gwplot-js-$VERSION.tgz"
