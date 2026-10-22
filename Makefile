# Build gwplot-js (gwplot.mjs + gwplot.wasm, and gwplot.node.mjs) from a gw checkout.
#
# Run from gw's root, with the dependencies build_deps.sh installed -- build.sh does this:
#
#   emmake make -f /path/to/gwplot-js/Makefile EMSCRIPTEN=1 DEPS=deps OUT=out
#
# It includes gw's own Makefile, so gw's sources are compiled as for gw's browser build
# (deps/wasm/flags.mk); only the entry point differs. gw's main.cpp starts a windowed
# browser; gwplot-js links src/gwplot.cpp instead, a headless renderer for JavaScript.

GWPLOT_JS := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DEPS ?= /opt/gw-wasm-deps
OUT ?= $(GWPLOT_JS)/out

WASM_SKIA_PATH := $(DEPS)/skia_wasm
WASM_SKIA_SRC := $(DEPS)/skia
WASM_HTS_PATH := $(DEPS)/htslib
WASM_LZMA_PATH := $(DEPS)/lzma
WASM_BUILD_DIR := $(OUT)/gw_objects

include Makefile

.DEFAULT_GOAL := module

# Speed: gw's browser build compiles its own code at -O2; gwplot-js uses -O3 and
# WebAssembly SIMD (in every browser from 2021 on), which draws ~15% faster. WebAssembly's
# own C++ exceptions (-fwasm-exceptions) would avoid going out through JavaScript for
# calls that might throw, but Skia's libraries (libpng's setjmp) are built for
# Emscripten's JavaScript ones, so they'd need rebuilding with them first. Override to
# compare, e.g. WASM_OPT=-O2.
WASM_EXCEPTIONS ?= -fexceptions
WASM_OPT ?= -O3 -msimd128
CPPFLAGS := $(filter-out -fexceptions,$(CPPFLAGS)) $(WASM_EXCEPTIONS)
LDFLAGS := $(filter-out -fexceptions,$(LDFLAGS)) $(WASM_EXCEPTIONS)
CXXFLAGS += $(WASM_OPT)
CFLAGS += $(WASM_OPT)
.PHONY: module

GW_OBJECTS := $(filter-out $(WASM_BUILD_DIR)/src/main.o,$(OBJECTS))
WRAPPER := $(OUT)/gwplot.o
MODULE := $(OUT)/gwplot.mjs

$(WRAPPER): $(GWPLOT_JS)/src/gwplot.cpp deps/wasm/flags.mk
	@mkdir -p $(dir $@)
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c $< -o $@

# gw's browser link flags, less what only its windowed demo needs: Asyncify (gwplot-js
# reads files synchronously, in a Web Worker: fs_bridge.mjs), callMain, IndexedDB settings
# storage and the demo's preloaded files and HTML shell; and native Skia's library
# directory, which gw's Makefile adds when a native build has fetched it. No -g, so the
# module carries no debug info.
MODULE_LDFLAGS := $(filter-out -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=% -sEXPORTED_RUNTIME_METHODS=% \
                    -lidbfs.js -L./lib/skia/% $(WASM_LDFLAGS_EXTRA),$(LDFLAGS)) \
    -lembind --no-entry \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createGwplot \
    -sEXPORTED_RUNTIME_METHODS=FS

# Linked twice: for the browser (a Web Worker), and for Node (tests/smoke.mjs). One module
# for both would import Node's 'module' package, which browsers can't load. Give the Node
# glue the browser's .wasm (wasmBinary) to run exactly what the browser does.
NODE_MODULE := $(OUT)/gwplot.node.mjs

# With them, fs_bridge.mjs and the TypeScript declarations (written by hand: gwplot.d.mts)
TYPES := $(addprefix $(GWPLOT_JS)/,gwplot.d.mts gwplot.node.d.mts fs_bridge.d.mts)

$(MODULE): $(GW_OBJECTS) $(WRAPPER) $(GWPLOT_JS)/Makefile $(GWPLOT_JS)/fs_bridge.mjs $(TYPES)
	$(CXX) $(filter-out -g,$(CXXFLAGS)) $(GW_OBJECTS) $(WRAPPER) $(MODULE_LDFLAGS) -sENVIRONMENT=worker $(LDLIBS) -o $@
	cp $(GWPLOT_JS)/fs_bridge.mjs $(TYPES) $(OUT)/

$(NODE_MODULE): $(GW_OBJECTS) $(WRAPPER) $(GWPLOT_JS)/Makefile
	$(CXX) $(filter-out -g,$(CXXFLAGS)) $(GW_OBJECTS) $(WRAPPER) $(MODULE_LDFLAGS) -sENVIRONMENT=node $(LDLIBS) -o $@

module: $(MODULE) $(NODE_MODULE)
