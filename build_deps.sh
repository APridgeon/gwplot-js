#!/usr/bin/env bash
# Build the libraries gwplot-js links against, for WebAssembly, and install just what the
# link needs (headers and static libraries) under PREFIX:
#
#   PREFIX/skia/              Skia m143 headers (include/, and modules/' headers)
#   PREFIX/skia_wasm/*.a      Skia (CanvasKit build, single-threaded), skcms, jpeg, png
#   PREFIX/htslib/            HTSlib 1.21 headers and libhts.a (no curl: the browser fetches)
#   PREFIX/lzma/liblzma.a     xz 5.2.5, which HTSlib needs
#   PREFIX/BUILD_INFO         what they were built from (see the end of this script)
#
#   ./build_deps.sh [GW_ROOT] [PREFIX]      (defaults: the gw submodule, deps)
#
# It runs gw's own deps/wasm/build.sh, so the versions and flags stay gw's, but stops it
# before its last step (building gw's demo page): build.sh builds gw's headless module
# from gw's sources, and keeping gw's sources out of this step means changing them
# needn't rebuild Skia (e.g. in a container layer). Needs an emsdk with Emscripten 3.1.65
# (EMSDK set), plus git, python3, curl, autoconf and bzip2. The Skia sources it fetches
# are large (~10 GB).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GW_ROOT="$(cd "${1:-$HERE/gw}" && pwd)"
PREFIX="${2:-$HERE/deps}"
mkdir -p "$PREFIX"
PREFIX="$(cd "$PREFIX" && pwd)"  # absolute: some copies below run from inside Skia's tree
WASM_DIR="$GW_ROOT/deps/wasm"
STEP3='^# 3\. Build GW for WASM'

# build.sh finds its directory from its own path, so the trimmed copy sits beside it.
grep -q "$STEP3" "$WASM_DIR/build.sh" || {
    echo "gw's deps/wasm/build.sh no longer has a '3. Build GW for WASM' step to stop before;" >&2
    echo "update gwplot-js build_deps.sh to match it." >&2
    exit 1
}

# Fetch Skia and its third-party sources first, retrying: they come from
# skia.googlesource.com, which rate-limits anonymous clones (HTTP 429) and build.sh
# fetches them all at once. Checkouts that succeeded are kept, so each retry fetches
# only what failed, and build.sh's own sync then finds everything in place.
eval "$(grep -E '^SKIA_(BRANCH|REPO)=' "$WASM_DIR/build.sh")"
if [ ! -d "$WASM_DIR/skia" ]; then
    git clone --branch "$SKIA_BRANCH" --depth 1 "$SKIA_REPO" "$WASM_DIR/skia"
fi
# Skip the third-party sources the CanvasKit build doesn't use and whose mirrors can't be
# fetched (they come back empty): the AVIF and JPEG XL codecs, Android audio, tracing,
# the experimental Vello renderer and Unicode's data tools. The trimmed list sits beside
# Skia's DEPS (paths are relative to it); build.sh's own sync picks it up from the env.
python3 - "$WASM_DIR/skia" <<'TRIM'
import sys
skia = sys.argv[1]
skip = {'libavif', 'libjxl', 'oboe', 'perfetto', 'vello', 'unicodetools'}
deps_file = {}
exec('def Var(x): return vars[x]\n' + open(f'{skia}/DEPS').read(), deps_file)
deps = {path: v for path, v in deps_file['deps'].items() if path.rsplit('/', 1)[-1] not in skip}
open(f'{skia}/DEPS.gwplot-js', 'w').write(f'deps = {deps!r}\n')
TRIM
export GIT_SYNC_DEPS_PATH="$WASM_DIR/skia/DEPS.gwplot-js"
for attempt in 1 2 3 4 5 6; do
    if (cd "$WASM_DIR/skia" && GIT_SYNC_DEPS_SKIP_EMSDK=1 GIT_SYNC_DEPS_QUIET=1 python3 tools/git-sync-deps); then
        break
    fi
    [ "$attempt" -eq 6 ] && { echo "Skia's third-party sources could not be fetched" >&2; exit 1; }
    echo "Fetching Skia's sources failed (attempt $attempt); retrying in $((attempt * 60))s" >&2
    sleep $((attempt * 60))
done

trimmed="$WASM_DIR/.build_deps_only.sh"
sed "/$STEP3/,\$d" "$WASM_DIR/build.sh" > "$trimmed"
bash "$trimmed"
rm "$trimmed"

mkdir -p "$PREFIX/skia" "$PREFIX/htslib" "$PREFIX/lzma"
cp -r "$WASM_DIR/skia/include" "$PREFIX/skia/"
# public headers include some of modules/ (skcms); take all of its headers
(cd "$WASM_DIR/skia" && find modules -name '*.h' -exec cp --parents {} "$PREFIX/skia/" \;)
cp -r "$WASM_DIR/out/skia_wasm" "$PREFIX/"
cp -r "$WASM_DIR/out/htslib/htslib" "$WASM_DIR/out/htslib/libhts.a" "$PREFIX/htslib/"
cp "$WASM_DIR/xz-5.2.5/src/liblzma/.libs/liblzma.a" "$PREFIX/lzma/"

# What these were built from, so a prebuilt copy (a release's gwplot-js-deps tarball) can
# be checked against the gw it's used with: gw_deps_build_sh must match the SHA-256 of
# that gw's deps/wasm/build.sh.
value() { grep -m1 -E "^$1=" "$WASM_DIR/build.sh" | cut -d= -f2 | tr -d '"'; }
cat > "$PREFIX/BUILD_INFO" <<INFO
gw_deps_build_sh=$(sha256sum "$WASM_DIR/build.sh" | cut -d' ' -f1)
emscripten=$(value EMSCRIPTEN_TARGET)
skia=$(value SKIA_BRANCH)
htslib=$(value HTSLIB_VERSION)
gwplot_js=$(git -C "$HERE" describe --tags --always --dirty 2>/dev/null || echo unknown)
INFO
echo "WebAssembly dependencies installed in $PREFIX:"
cat "$PREFIX/BUILD_INFO"
