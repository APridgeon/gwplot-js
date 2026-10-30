// gwplot.d.mts: TypeScript declarations for gwplot.mjs (and gwplot.node.mjs), gw's
// headless module. Written by hand from the EMSCRIPTEN_BINDINGS in gw's
// src/headless/gw_api.cpp; tests/smoke.mjs checks that Gw's methods here are the ones the
// module has.

/** Options for createGwplot (Emscripten's Module settings), of those that apply here. */
export interface GwplotOptions {
  /** The module's WebAssembly, instead of fetching it: under Node, gwplot.wasm's bytes. */
  wasmBinary?: ArrayBuffer | Uint8Array
  /** Where to find a file the module loads (gwplot.wasm), given its name. */
  locateFile?(path: string, prefix: string): string
  /** gw's standard output and error, one line at a time. */
  print?(text: string): void
  printErr?(text: string): void
}

/** Emscripten's in-memory file system, as far as gwplot-js's users and fs_bridge use it. */
export interface EmscriptenFS {
  mkdir(path: string, mode?: number): unknown
  writeFile(path: string, data: string | ArrayBufferView, opts?: { flags?: string }): void
  readFile(path: string, opts?: { encoding?: 'binary' }): Uint8Array
  readFile(path: string, opts: { encoding: 'utf8' }): string
  unlink(path: string): void
  createFile(parent: string, name: string, properties: unknown, canRead: boolean, canWrite: boolean): EmscriptenFSNode
  open(path: string, flags: string | number, mode?: number): EmscriptenFSStream
  read(stream: EmscriptenFSStream, buffer: ArrayBufferView, offset: number, length: number, position?: number): number
  close(stream: EmscriptenFSStream): void
  ErrnoError: new (errno: number) => Error
}

/** A file in Emscripten's file system. */
export interface EmscriptenFSNode {
  stream_ops: Record<string, (...args: any[]) => any>
  [key: string]: unknown
}

/** An open file in Emscripten's file system. */
export interface EmscriptenFSStream {
  [key: string]: unknown
}

/** gw's colour themes. */
export type Theme = 'slate' | 'dark' | 'igv'

/** A loaded annotation track (gwplot's get_tracks). */
export interface Track {
  index: number
  name: string
  /** gw's track kind; INTRON_TRACK_KIND for an intron track */
  kind: number
  bam_index: number
  height_fraction: number
}

/** A pane: a region on screen. */
export interface Region {
  index: number
  chrom: string
  start: number
  end: number
}

/** The scale bar's band and the panes (gwplot's get_viewport), in frame-buffer pixels. */
export interface Viewport {
  scale_bar_enabled: boolean
  scale_bar_top: number
  scale_bar_bottom: number
  gap: number
  regions: Region[]
}

/**
 * A headless gw: it draws into memory, not a window. Its methods are ports of gwplot's
 * Python Gw, under camelCase names. Free it with delete() when done.
 *
 * C++ exceptions reach JavaScript as a number: Module.exceptionMessage(e) says what they were.
 */
export class Gw {
  /** gw's default settings, as gwplot's Gw(reference) without an ini. */
  constructor(reference: string, width: number, height: number)
  /** Settings from a gw .gw.ini already in the file system ('' for gw's defaults). */
  constructor(reference: string, width: number, height: number, iniPath: string)

  // --- Files and regions

  addBam(path: string): void
  addTrack(path: string): void
  addRegion(chrom: string, start: number, end: number): void
  clearRegions(): void

  // --- Commands and input

  /** A gw command line, as typed into gw's command box. "expand-tracks on|off" sets the option rather than toggling it. */
  applyCommand(command: string): void
  /** A key event; key is one of Module.KEY_*, action Module.PRESS or Module.RELEASE. */
  keyPress(key: number, scancode: number, action: number, mods: number): void
  /**
   * A button press or release at (x, y) in frame-buffer pixels: button Module.MOUSE_BUTTON_*,
   * action Module.PRESS or Module.RELEASE, mods Module.MOD_* bits.
   */
  mouseEvent(x: number, y: number, button: number, action: number, mods?: number): void
  /** The pointer moved to (x, y): after a left press, a drag (pans, or moves the scale bar or a track divider). */
  mouseMove(x: number, y: number): void
  /** A wheel or trackpad scroll, in steps: gw zooms (dy) or pans (dx). */
  scroll(dx: number, dy: number): void

  // --- Markers

  addMarker(chrom: string, pos: number): void
  removeMarker(chrom: string, pos: number): void
  clearMarkers(): void

  // --- Selection

  /** The selected read's SAM record, or ''. */
  selectedAlign(): string
  selectedIntron(): string
  selectedFeature(): string
  clearSelectedAlign(): void
  clearSelectedIntron(): void
  clearSelectedFeature(): void
  /** Jump to the selected read's mate and select it: its SAM record, or '' if not found. */
  selectMate(): string

  // --- Layout

  setCanvasSize(width: number, height: number): void
  width(): number
  height(): number
  /** Whether the next draw re-reads the alignments. */
  clearBuffer(): boolean
  /** Whether the picture changed since the last draw. */
  redraw(): boolean
  vscroll(): number
  setVscroll(value: number): void
  /** Peak read depth over the alignments, to size a scrollbar. */
  pileupDepth(): number
  /** The loaded annotation tracks, in draw order. */
  tracks(): Track[]
  viewport(): Viewport

  // --- Display settings

  theme(): string
  /** Throws (a C++ exception) for any other name. */
  setTheme(name: Theme): void
  ylim(): number
  setYlim(ylim: number): void
  softClipThreshold(): number
  setSoftClipThreshold(value: number): void
  smallIndelThreshold(): number
  setSmallIndelThreshold(value: number): void
  snpThreshold(): number
  setSnpThreshold(value: number): void
  edgeHighlights(): number
  setEdgeHighlights(value: number): void
  maxCoverage(): number
  setMaxCoverage(value: number): void
  log2Cov(): boolean
  setLog2Cov(value: boolean): void
  expandTracks(): boolean
  setExpandTracks(value: boolean): void
  mods(): boolean
  drawLine(): boolean
  minJunctionReads(): number
  tabTrackHeight(): number
  setTrackHeight(index: number, height: number): void
  translation(): boolean
  /** 1, 2 or 3 */
  translationFrame(): number
  translationStrand(): '+' | '-'
  setTranslation(enabled: boolean): void
  setTranslationFrame(frame: 1 | 2 | 3): void
  setTranslationStrand(strand: '+' | 'forward' | 'f' | 'plus' | '-' | 'reverse' | 'r' | 'minus'): void

  // --- Drawing

  /** Draw the current view. */
  draw(): void
  /**
   * The last drawn frame, as unpremultiplied RGBA: width() * height() * 4 bytes. A view of
   * the module's memory, valid only until the next call into it: copy it (.slice()).
   */
  pixels(): Uint8Array
  /** The last drawn frame as a PNG; a view of the module's memory, like pixels(). */
  encodePng(compression: number): Uint8Array
  /** What gw has logged since the last call. */
  flushLog(): string

  // --- embind

  /** Free the C++ object. */
  delete(): void
  isDeleted(): boolean
}

/** The loaded module. */
export interface GwplotModule {
  Gw: typeof Gw
  FS: EmscriptenFS
  /** What a C++ exception was: they reach JavaScript as a number. */
  exceptionMessage(pointer: number): string

  // GLFW's constants, for keyPress and mouseEvent
  readonly KEY_RIGHT: number
  readonly KEY_LEFT: number
  readonly KEY_UP: number
  readonly KEY_DOWN: number
  readonly KEY_PAGE_UP: number
  readonly KEY_PAGE_DOWN: number
  readonly PRESS: number
  readonly RELEASE: number
  readonly MOUSE_BUTTON_LEFT: number
  readonly MOUSE_BUTTON_RIGHT: number
  readonly MOUSE_BUTTON_MIDDLE: number
  readonly MOD_SHIFT: number
  readonly MOD_CONTROL: number
  readonly MOD_ALT: number
  readonly MOD_SUPER: number
  /** Track.kind of an intron track */
  readonly INTRON_TRACK_KIND: number
}

/** Load the module. */
export default function createGwplot(options?: GwplotOptions): Promise<GwplotModule>
