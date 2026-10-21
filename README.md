# gwplot-js

[gw](https://github.com/kcleal/gw), the genome browser, as a WebAssembly module for
JavaScript: the browser counterpart of [gwplot](https://github.com/kcleal/gwplot)'s
Python `Gw`.

`Gw` is a headless gw. It draws into memory, not a window, and hands the frame back as RGBA
pixels (for a canvas) or a PNG. Its methods are ports of gwplot's, under camelCase names,
so a page can drive gw the way a Python program drives gwplot, and draw the same picture
from the same gw.

`fs_bridge.mjs` lets gw read BAM, CRAM, FASTA, VCF and annotation files from a web server
with HTTP range requests, as htslib reads them off disk. It can also keep files that are
the same for everyone (a reference genome) in the browser between visits.

## Building

The build runs in Emscripten 3.1.65, for instance its container image:

```sh
git clone --recursive https://github.com/APridgeon/gwplot-js && cd gwplot-js
podman run --rm -v "$PWD:/src:Z" -w /src docker.io/emscripten/emsdk:3.1.65 bash -c '
  apt-get update && apt-get install -y autoconf ninja-build &&
  ./build_deps.sh &&        # Skia, HTSlib and xz for WebAssembly, into deps/ (once; slow)
  ./build.sh &&             # the module, into out/<version>/
  node tests/smoke.mjs out  # draws a frame from gw/test and checks it'
```

- **`build_deps.sh [GW_ROOT] [PREFIX]`** runs gw's own `deps/wasm/build.sh`, stopping before it builds gw's demo page, and installs just the headers and static libraries.
  - Skia's sources are about 10 GB.
  - `skia.googlesource.com` rate-limits anonymous clones, so the script retries.
  - It skips the few Skia dependencies that CanvasKit doesn't use and whose mirrors come back empty.
- **`build.sh [GW_ROOT] [DEPS] [DEST]`** compiles gw's sources with gw's own browser flags (`deps/wasm/flags.mk`) plus `-O3 -msimd128`, and links `src/gwplot.cpp` in place of gw's windowed `main.cpp`.
  - Output goes to `DEST/<version>/` with a `manifest.json` that names the version. The version is a hash of the files, so they can be cached indefinitely.
  - `GW_ROOT` can be any gw checkout: an app that also uses gwplot can build against gwplot's own gw, so both draw from the same gw.
  - `GWPLOT_JS_EXTRA_FILES` adds an app's own files to the version directory and its hash.

| file | |
|---|---|
| `gwplot.mjs` + `gwplot.wasm` | the module, for a browser (a Web Worker) |
| `gwplot.node.mjs` | the same for Node; pass it the browser's `.wasm` as `wasmBinary` |
| `fs_bridge.mjs` | reading files from a web server |

## Releases

Pushing a version tag (`git tag v0.1.0 && git push origin v0.1.0`) publishes a GitHub release
with:

| file | |
|---|---|
| `gwplot-js-deps-<tag>.tar.gz` | the dependencies `build_deps.sh` builds (Skia, HTSlib, xz), so you needn't build Skia |
| `gwplot-js-<tag>.tar.gz` | the module, as `build.sh` installs it: `manifest.json` and its version directory |
| `SHA256SUMS` | checksums of both |

To build the module from the prebuilt dependencies:

```sh
mkdir deps && tar -xzf gwplot-js-deps-v0.1.0.tar.gz -C deps --strip-components=1
./build.sh <your gw> deps out
```

The dependencies follow gw's `deps/wasm/build.sh`, so they fit any gw whose `build.sh` is
the one they were built from. That file's SHA-256 is `gw_deps_build_sh` in the bundle's
`BUILD_INFO`:

```sh
grep gw_deps_build_sh deps/BUILD_INFO; sha256sum <your gw>/deps/wasm/build.sh
```

## Using it

Run it in a Web Worker: the file bridge's reads are synchronous, which browsers only
allow off the main thread, and a draw then never blocks the page.

```js
import createGwplot from './gwplot.mjs'
import { fetchWhole, mountUrl, openPageStore, writeFile } from './fs_bridge.mjs'

const Module = await createGwplot()
const { FS } = Module

// indexes whole; the big files a range at a time, as gw reads them
writeFile(FS, '/data/ref.fa.fai', await fetchWhole('/files/ref.fa.fai'))
writeFile(FS, '/data/sample.bam.bai', await fetchWhole('/files/sample.bam.bai'))
mountUrl(FS, '/data/ref.fa', '/files/ref.fa', { store: await openPageStore('ref.fa') })
mountUrl(FS, '/data/sample.bam', '/files/sample.bam')

const gw = new Module.Gw('/data/ref.fa', 1200, 800)  // or (…, '/path/in/FS/to/.gw.ini')
gw.addBam('/data/sample.bam')
gw.applyCommand('chr1:1000000-1010000')
gw.draw()
const image = new ImageData(new Uint8ClampedArray(gw.pixels().slice()), gw.width(), gw.height())
postMessage(await createImageBitmap(image))  // to the page, for a canvas
```

C++ exceptions reach JavaScript as a number; `Module.exceptionMessage(e)` says what they were.

### `Gw`

| | gwplot |
|---|---|
| `new Gw(reference, width, height[, iniPath])` | `Gw(reference, ini=…, canvas_width=, canvas_height=)`; without an ini, gw's defaults |
| `addBam(path)`, `addTrack(path)`, `addRegion(chrom, start, end)`, `clearRegions()` | `add_bam`, `add_track`, `add_region`, `clear_regions` |
| `applyCommand(command)` | `apply_command` (`expand-tracks on\|off` sets rather than toggles) |
| `keyPress(key, scancode, action, mods)`, `mouseEvent(x, y, button, action)` | `key_press`, `mouse_event`; constants `Module.KEY_*`, `PRESS`, `RELEASE`, `MOUSE_BUTTON_LEFT` |
| `addMarker(chrom, pos)`, `removeMarker(chrom, pos)`, `clearMarkers()` | `add_marker`, `remove_marker`, `clear_markers` |
| `selectedAlign()`, `selectedIntron()`, `selectedFeature()`, `clearSelected…()`, `selectMate()` | `selected_align`, …, `select_mate` |
| `setCanvasSize(w, h)`, `width()`, `height()`, `vscroll()`, `setVscroll(n)`, `pileupDepth()` | `set_canvas_size`, `canvas_size`, `vscroll`, `set_vscroll`, `pileup_depth` |
| `tracks()`, `viewport()` | `get_tracks`, `get_viewport` |
| `theme()`/`setTheme`, `ylim()`/`setYlim`, `softClipThreshold()`/`set…`, `smallIndelThreshold`, `snpThreshold`, `edgeHighlights`, `maxCoverage`, `log2Cov`, `expandTracks`, `mods()`, `drawLine()`, `minJunctionReads()`, `tabTrackHeight()`, `setTrackHeight(i, h)`, `translation()`/`setTranslation`, `translationFrame`, `translationStrand` | the same settings |
| `clearBuffer()`, `redraw()` | `clear_buffer`, `redraw`: whether the next draw re-reads, or the picture changed |
| `draw()`, `pixels()`, `encodePng(level)`, `flushLog()` | `draw`, `array()`, `encode_as_png`, `flush_log` |

`pixels()` is a view of the module's memory, valid until the next call: copy it (`.slice()`).

### `fs_bridge.mjs`

- **`mountUrl(FS, path, url, options)`** puts `url` in the file system, read on demand.
  - A read of many pages is fetched as one request per run of missing pages, up to `maxRequest` (8 MiB). Sequential reads fetch ahead, up to `maxReadahead` (4 MiB).
  - Pages are kept in memory up to `cacheBytes` (64 MiB).
  - The server must answer `Range` requests with 206 and the file's size in `Content-Range`, and should send an `ETag`. If the ETag changes while the file is open, reads fail rather than mixing two versions.
- **`openPageStore(name)`** keeps a file's pages in the browser's origin-private file system (OPFS) between visits, keyed by its ETag.
  - Only use it for files that are the same for everyone.
  - It returns null where there's no OPFS, or when another tab has that store open.
- **`fetchWhole(url)`** and **`writeFile(FS, path, bytes)`** handle small files, such as indexes.
- **`fetchTotals()`** gives running counts of requests, bytes, waiting time and pages read from a store.

## Things to know

- **Single-threaded.** Skia's CanvasKit build is single-threaded, so gw is too. htslib logs once that it can't start a thread pool, and reads without one.
- **CRAM needs a lot of reference.** To decode a slice, htslib loads the reference across the slice's whole span, which for sparse targeted data can be most of a chromosome. A bgzip-compressed FASTA (with `.fai` and `.gzi`) sends about a quarter of the bytes, and a page store keeps it for next time. CRAMs written with `embed_ref=2`, or BAMs, avoid the cost.
- **Browser support.** WebAssembly SIMD and module workers: Chrome/Edge 91+, Firefox 114+, Safari 16.4+. OPFS sync access handles: Chrome 102+, Firefox 111+, Safari 15.2+.
- **No `"type": "module"` in `package.json`.** The modules are `.mjs` already. Node applies that setting to files without an extension too, which includes the test programs Emscripten compiles while configuring xz and HTSlib (CommonJS scripts), so they fail with "cannot run C compiled programs".
- **No Asyncify, JavaScript C++ exceptions.** Files are read synchronously, so the module needs no Asyncify. WebAssembly's own exceptions (`-fwasm-exceptions`) would be faster, but they need Skia's libraries rebuilt with WebAssembly setjmp/longjmp.
