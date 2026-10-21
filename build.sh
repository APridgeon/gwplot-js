#!/usr/bin/env bash
# Build gwplot-js and install it, versioned, for a web server to serve as static files:
#
#   ./build.sh [GW_ROOT] [DEPS] [DEST]
#
#   GW_ROOT  a gw checkout (default: the gw submodule)
#   DEPS     what build_deps.sh installed (default: deps)
#   DEST     where to install (default: out), which then holds
#              <version>/gwplot.mjs, gwplot.wasm, fs_bridge.mjs,
#                        gwplot.node.mjs (the same module for Node)
#              manifest.json  {"version": "<version>", "module": "<version>/gwplot.mjs"}
#
# The version is a hash of the files, so a browser can cache them indefinitely: a new
# build has a new URL. GWPLOT_JS_EXTRA_FILES (paths, space-separated) are installed and
# hashed with them, for an app's own JavaScript that must match this build. Objects are
# built in a temporary directory, or in GWPLOT_JS_BUILD_DIR if set (kept, for quicker
# rebuilds); GWPLOT_JS_MAKE_ARGS are passed to make (e.g. WASM_OPT=-O2). Needs
# Emscripten 3.1.65 (emmake) on the PATH.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GW_ROOT="$(cd "${1:-$HERE/gw}" && pwd)"
DEPS="$(cd "${2:-$HERE/deps}" && pwd)"
DEST="${3:-$HERE/out}"
if [ -n "${GWPLOT_JS_BUILD_DIR:-}" ]; then
    OUT="$GWPLOT_JS_BUILD_DIR"
    mkdir -p "$OUT"
else
    OUT="$(mktemp -d)"
    trap 'rm -rf "$OUT"' EXIT
fi

cd "$GW_ROOT"
env -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS -u LDLIBS \
    emmake make -f "$HERE/Makefile" -j"${JOBS:-$(nproc)}" EMSCRIPTEN=1 DEPS="$DEPS" OUT="$OUT" ${GWPLOT_JS_MAKE_ARGS:-}

files=("$OUT/gwplot.mjs" "$OUT/gwplot.wasm" "$OUT/fs_bridge.mjs" "$OUT/gwplot.node.mjs")
for extra in ${GWPLOT_JS_EXTRA_FILES:-}; do files+=("$(cd "$(dirname "$extra")" && pwd)/$(basename "$extra")"); done
version="$(cat "${files[@]}" | sha256sum | cut -c1-12)"
mkdir -p "$DEST/$version"
cp "${files[@]}" "$DEST/$version/"
printf '{"version": "%s", "module": "%s/gwplot.mjs"}\n' "$version" "$version" > "$DEST/manifest.json"
echo "gwplot-js is in $DEST/$version ($(du -h "$DEST/$version/gwplot.wasm" | cut -f1) of wasm)"
