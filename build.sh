#!/usr/bin/env bash
# Build gwplot-js and install it, versioned, for a web server to serve as static files:
#
#   ./build.sh [GW_ROOT] [DEPS] [DEST]
#
#   GW_ROOT  a gw checkout with the headless build, `make headless` (default: the gw
#            submodule)
#   DEPS     what build_deps.sh installed (default: deps)
#   DEST     where to install (default: out), which then holds
#              <version>/gwplot.mjs, gwplot.wasm, fs_bridge.mjs,
#                        gwplot.node.mjs (the same module for Node),
#                        *.d.mts (their TypeScript declarations)
#              manifest.json  {"version": "<version>", "module": "<version>/gwplot.mjs"}
#
# gw builds the module itself (its headless target: src/headless/gw_api.cpp in place of
# its windowed UI); gwplot-js adds the file bridge and TypeScript declarations, and
# versions them. The version is a hash of the files, so a browser can cache them
# indefinitely: a new build has a new URL. GWPLOT_JS_EXTRA_FILES (paths, space-separated)
# are installed and hashed with them, for an app's own JavaScript that must match this
# build. Objects are built in a temporary directory, or in GWPLOT_JS_BUILD_DIR if set
# (kept, for quicker rebuilds); GWPLOT_JS_MAKE_ARGS are passed to make.
#
# Speed: gw's browser UI compiles at -O2; gwplot-js asks for -O3 and WebAssembly SIMD (in
# every browser from 2021 on), which draws ~15% faster. Override to compare, e.g.
# WASM_OPT=-O2. Needs Emscripten 3.1.65 (emmake) on the PATH.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GW_ROOT="$(cd "${1:-$HERE/gw}" && pwd)"
if ! grep -q '^headless:' "$GW_ROOT/Makefile"; then
    echo "$GW_ROOT has no headless build (make headless); gwplot-js needs a gw with one" >&2
    exit 1
fi
DEPS="$(cd "${2:-$HERE/deps}" && pwd)"
mkdir -p "${3:-$HERE/out}"
DEST="$(cd "${3:-$HERE/out}" && pwd)"
# absolute, before the build changes directory
extras=()
for extra in ${GWPLOT_JS_EXTRA_FILES:-}; do extras+=("$(cd "$(dirname "$extra")" && pwd)/$(basename "$extra")"); done
if [ -n "${GWPLOT_JS_BUILD_DIR:-}" ]; then
    mkdir -p "$GWPLOT_JS_BUILD_DIR"
    OUT="$(cd "$GWPLOT_JS_BUILD_DIR" && pwd)"
else
    OUT="$(mktemp -d)"
    trap 'rm -rf "$OUT"' EXIT
fi

cd "$GW_ROOT"
env -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS -u LDLIBS \
    emmake make -j"${JOBS:-$(nproc)}" EMSCRIPTEN=1 headless \
    WASM_SKIA_PATH="$DEPS/skia_wasm" WASM_SKIA_SRC="$DEPS/skia" \
    WASM_HTS_PATH="$DEPS/htslib" WASM_LZMA_PATH="$DEPS/lzma" \
    WASM_BUILD_DIR="$OUT/gw_objects" HEADLESS_OUT="$OUT" \
    WASM_OPT="${WASM_OPT:--O3 -msimd128}" ${GWPLOT_JS_MAKE_ARGS:-}

# gw's module (its Node build is given gwplot.wasm, so its own gwplot.node.wasm isn't
# needed), and gwplot-js's own files
files=("$OUT/gwplot.mjs" "$OUT/gwplot.wasm" "$OUT/gwplot.node.mjs")
files+=("$HERE/fs_bridge.mjs" "$HERE/gwplot.d.mts" "$HERE/gwplot.node.d.mts" "$HERE/fs_bridge.d.mts")
files+=("${extras[@]}")
version="$(cat "${files[@]}" | sha256sum | cut -c1-12)"
mkdir -p "$DEST/$version"
cp "${files[@]}" "$DEST/$version/"
printf '{"version": "%s", "module": "%s/gwplot.mjs"}\n' "$version" "$version" > "$DEST/manifest.json"
echo "gwplot-js is in $DEST/$version ($(du -h "$DEST/$version/gwplot.wasm" | cut -f1) of wasm)"
