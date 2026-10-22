// Smoke test for gwplot-js, under Node, on gw's own test data:
//
//   node tests/smoke.mjs MODULE_DIR [GW_TEST_DATA] [OUT_PNG]
//
// MODULE_DIR is where build.sh installed (its manifest.json says which version) or a
// version directory itself (gwplot.wasm, its Node glue, and fs_bridge.mjs); GW_TEST_DATA
// defaults to the gw submodule's test/. It opens the test
// BAM the way a browser would -- the large files through fs_bridge's range reads, here
// served from local disk -- draws a frame and checks what gw reports, then checks the
// bridge itself. With OUT_PNG it also saves the frame, to look at.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [moduleArg, testArg, outArg] = process.argv.slice(2)
if (!moduleArg) {
  console.error('usage: node tests/smoke.mjs MODULE_DIR [GW_TEST_DATA] [OUT_PNG]')
  process.exit(2)
}
let moduleDir = resolve(moduleArg)
if (existsSync(join(moduleDir, 'manifest.json'))) {
  moduleDir = join(moduleDir, JSON.parse(readFileSync(join(moduleDir, 'manifest.json'), 'utf8')).version)
}
const testData = resolve(testArg ?? join(here, '..', 'gw', 'test'))
const outPng = outArg && resolve(outArg)

// gwplot.node.mjs (the Node build) on the browser's gwplot.wasm, so this tests what a page runs
const { default: createGwplot } = await import(pathToFileURL(join(moduleDir, 'gwplot.node.mjs')).href)
const Module = await createGwplot({ wasmBinary: readFileSync(join(moduleDir, 'gwplot.wasm')) })
const { mountUrl, pageStore, writeFile } = await import(pathToFileURL(join(moduleDir, 'fs_bridge.mjs')).href)
const { FS } = Module

// A stand-in for the web server: the same range answers, from local files.
function localRange(path, start, end) {
  const fd = openSync(path)
  try {
    const size = fstatSync(fd).size
    const bytes = Buffer.alloc(Math.max(0, Math.min(end, size - 1) - start + 1))
    readSync(fd, bytes, 0, bytes.length, start)
    return { bytes: new Uint8Array(bytes), size, etag: `"${size}"` }
  } finally {
    closeSync(fd)
  }
}

function check(ok, message) {
  if (!ok) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
  console.log(`ok: ${message}`)
}

/** Run ``fn``; C++ exceptions reach JavaScript as a pointer, so say what they were. */
function run(fn) {
  try {
    return fn()
  } catch (error) {
    console.error('FAIL:', typeof error === 'number' ? Module.exceptionMessage(error) : error)
    process.exit(1)
  }
}

// Small pages, so even the 11 kb test reference takes several range reads.
const options = { pageSize: 4096, fetchRange: localRange }
const mounts = {
  reference: mountUrl(FS, '/data/test.fa', join(testData, 'test.fa'), options),
  alignment: mountUrl(FS, '/data/test.bam', join(testData, 'test.bam'), options),
  annotation: mountUrl(FS, '/data/test.gff3', join(testData, 'test.gff3'), options),
  'indexed annotation': mountUrl(FS, '/data/test.gff3.gz', join(testData, 'test.gff3.gz'), options),
}
for (const index of ['test.bam.bai', 'test.gff3.gz.tbi']) {
  writeFile(FS, `/data/${index}`, readFileSync(join(testData, index)))
}
writeFile(FS, '/data/test.fa.fai', new TextEncoder().encode(faidx(readFileSync(join(testData, 'test.fa'), 'latin1'))))

/** A FASTA's .fai (gw's test data has none): name, length, offset, bases and bytes a line. */
function faidx(fasta) {
  const rows = []
  let at = 0
  let entry = null
  for (const line of fasta.split('\n')) {
    const bytes = line.length + 1
    if (line.startsWith('>')) {
      entry = { name: line.slice(1).split(/\s/)[0], length: 0, offset: at + bytes, bases: 0, width: 0 }
      rows.push(entry)
    } else if (entry && line.length) {
      if (!entry.bases) [entry.bases, entry.width] = [line.length, bytes]
      entry.length += line.length
    }
    at += bytes
  }
  return rows.map((e) => `${e.name}\t${e.length}\t${e.offset}\t${e.bases}\t${e.width}\n`).join('')
}

// gw's default settings (no ini), as gwplot's Gw(reference)
const plot = run(() => new Module.Gw('/data/test.fa', 400, 300))
run(() => {
  plot.addBam('/data/test.bam')
  plot.addTrack('/data/test.gff3')
  plot.applyCommand('chr1:9900-10300')
  plot.draw()
})
check(plot.width() === 400 && plot.height() === 300, `a ${plot.width()}x${plot.height()} canvas, on gw's default settings`)
const pixels = plot.pixels().slice()
check(pixels.length === 400 * 300 * 4, `${pixels.length} bytes of RGBA`)
const colours = new Set()
for (let i = 0; i < pixels.length; i += 4) colours.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2])
check(colours.size > 20, `the frame has ${colours.size} colours (reads, coverage, annotation), not a blank canvas`)

const viewport = plot.viewport()
const pane = viewport.regions[0]
check(viewport.regions.length === 1 && pane.chrom === 'chr1' && pane.start === 9900 && pane.end === 10300,
  `the viewport is the one pane, ${pane.chrom}:${pane.start}-${pane.end}`)
const tracks = plot.tracks()
check(tracks.length === 1 && tracks[0].name.length > 0, `the annotation track is listed (${tracks[0]?.name})`)
check(plot.pileupDepth() > 0, `the reads pile up ${plot.pileupDepth()} deep`)

// The TypeScript declarations (written by hand) have the module's methods: the build's
// copy, or the repo's for a build from before there were any.
{
  const installed = join(moduleDir, 'gwplot.d.mts')
  const types = readFileSync(existsSync(installed) ? installed : join(here, '..', 'gwplot.d.mts'), 'utf8')
  const block = /^export class Gw \{([\s\S]*?)^\}/m.exec(types)[1]
  const embind = new Set(['constructor', 'delete', 'isDeleted'])
  const declared = new Set([...block.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).filter((n) => !embind.has(n)))
  const bound = new Set(Object.getOwnPropertyNames(Module.Gw.prototype).filter((n) => !embind.has(n)))
  const missing = [...bound].filter((n) => !declared.has(n))
  const extra = [...declared].filter((n) => !bound.has(n))
  check(missing.length === 0 && extra.length === 0,
    `gwplot.d.mts declares Gw's ${bound.size} methods` +
    (missing.length ? `; not declared: ${missing.join(', ')}` : '') + (extra.length ? `; not bound: ${extra.join(', ')}` : ''))
}

// Click down the reads until one is selected: its SAM record, then its mate (or '').
let read = ''
for (let y = 60; y < 240 && !read; y += 4) {
  plot.clearSelectedAlign()
  plot.mouseEvent(200, y, Module.MOUSE_BUTTON_LEFT, Module.PRESS)
  plot.mouseEvent(200, y, Module.MOUSE_BUTTON_LEFT, Module.RELEASE)
  read = plot.selectedAlign()
}
check(read.split('\t').length >= 11, `clicking a read selects it (${read.split('\t')[0]})`)
const mate = run(() => plot.selectMate())
check(mate === '' || mate.split('\t')[0] === read.split('\t')[0], `selectMate gives its mate's record, or '' (${mate ? 'found' : 'not in view'})`)

// An ini of its own, and a tabix-indexed annotation
const second = run(() => new Module.Gw('/data/test.fa', 300, 200, '/tmp/.gw.ini')) // gw wrote its default there
run(() => {
  second.addBam('/data/test.bam')
  second.addTrack('/data/test.gff3.gz')
  second.applyCommand('chr1:9900-10300')
  second.draw()
})
check(second.tracks().length === 1, 'a second Gw reads an ini file and a tabix-indexed annotation')
second.delete()

for (const [name, mount] of Object.entries(mounts)) {
  check(mount.requests() > 0, `the ${name} (${mount.size} bytes) was read in ${mount.requests()} range requests`)
}

// The bridge hands back exactly the file's bytes: random reads of all sizes (within a
// page, across pages, beyond the cache), and runs of sequential ones (readahead).
{
  const file = readFileSync(join(testData, 'test.bam'))
  const fd = FS.open('/data/test.bam', 'r')
  let seed = 7
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  let bad = 0
  const reads = []
  for (let i = 0; i < 200; i++) reads.push([random(file.length), 1 + random(i % 10 === 0 ? 300000 : 9000)])
  for (let at = 1000, i = 0; i < 100; i++, at += 700) reads.push([at, 700])
  for (const [at, n] of reads) {
    const buffer = new Uint8Array(n)
    const got = FS.read(fd, buffer, 0, n, at)
    const want = file.subarray(at, at + n)
    if (got !== want.length || !buffer.subarray(0, got).every((b, j) => b === want[j])) bad++
  }
  FS.close(fd)
  check(bad === 0, `${reads.length} reads through the bridge match the file byte for byte`)
}

// A page store (in the browser, OPFS) serves a second visit without fetching again, and
// starts again when the file's ETag changes. In-memory stand-ins for sync access handles:
{
  const memoryHandle = () => {
    let bytes = new Uint8Array(0)
    return {
      getSize: () => bytes.length,
      read(into, { at }) {
        const n = Math.max(0, Math.min(into.length, bytes.length - at))
        into.set(bytes.subarray(at, at + n))
        return n
      },
      write(data, { at }) {
        if (at + data.length > bytes.length) {
          const grown = new Uint8Array(at + data.length)
          grown.set(bytes)
          bytes = grown
        }
        bytes.set(data, at)
        return data.length
      },
      truncate(size) { bytes = bytes.slice(0, size) },
      flush() {},
    }
  }
  const handles = { data: memoryHandle(), index: memoryHandle(), meta: memoryHandle() }
  const file = readFileSync(join(testData, 'test.bam'))
  const readAll = (path) => {
    const fd = FS.open(path, 'r')
    const all = new Uint8Array(file.length)
    for (let at = 0; at < file.length; at += 50000) FS.read(fd, all, at, Math.min(50000, file.length - at), at)
    FS.close(fd)
    return all
  }
  const same = (bytes) => bytes.length === file.length && bytes.every((b, i) => b === file[i])
  const mount = (name, etag) => mountUrl(FS, `/stored/${name}`, join(testData, 'test.bam'), {
    pageSize: 4096,
    store: pageStore(handles),
    fetchRange: (path, start, end) => ({ ...localRange(path, start, end), etag }),
  })
  const first = mount('first.bam', '"v1"')
  check(same(readAll('/stored/first.bam')), `a first visit reads the file whole (${first.requests()} requests)`)
  const again = mount('again.bam', '"v1"')
  const bytes = readAll('/stored/again.bam')
  check(same(bytes) && again.requests() === 1, `a second visit reads it from the store (${again.requests()} request, for its size)`)
  const changed = mount('changed.bam', '"v2"')
  check(same(readAll('/stored/changed.bam')) && changed.requests() > 1,
    `a changed file is fetched again (${changed.requests()} requests)`)
}

if (outPng) {
  writeFileSync(outPng, plot.encodePng(6).slice())
  console.log(`wrote ${outPng}`)
}
plot.delete()
