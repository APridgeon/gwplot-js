// Type test for the TypeScript declarations (gwplot.d.mts, fs_bridge.d.mts): never run,
// only checked, as CI does:
//
//   npx --yes -p typescript@5 tsc --noEmit --strict --target es2022 --lib es2022,dom \
//     --module nodenext --moduleResolution nodenext tests/types.mts
//
// It uses the API as the README and tests/smoke.mjs do; each @ts-expect-error line is a
// misuse the types must catch (tsc fails if one isn't an error).

import createGwplot, { type GwplotModule, type Track, type Viewport } from '../gwplot.mjs'
import createNode from '../gwplot.node.mjs'
import { fetchTotals, fetchWhole, mountUrl, openPageStore, writeFile, type Mount } from '../fs_bridge.mjs'

const Module: GwplotModule = await createGwplot()
const { FS } = Module

writeFile(FS, '/data/ref.fa.fai', await fetchWhole('/files/ref.fa.fai'))
const mount: Mount = mountUrl(FS, '/data/ref.fa', '/files/ref.fa', { store: await openPageStore('ref.fa'), pageSize: 4096 })
const requests: number = mount.requests() + fetchTotals().requests

const gw = new Module.Gw('/data/ref.fa', 1200, 800)
const configured = new Module.Gw('/data/ref.fa', 1200, 800, '/tmp/.gw.ini')
gw.addBam('/data/sample.bam')
gw.applyCommand('chr1:1000000-1010000')
gw.setTheme('igv')
gw.mouseEvent(10, 20, Module.MOUSE_BUTTON_LEFT, Module.PRESS)
try {
  gw.draw()
} catch (error) {
  if (typeof error === 'number') console.error(Module.exceptionMessage(error))
}
const image = new ImageData(new Uint8ClampedArray(gw.pixels().slice()), gw.width(), gw.height())
const png: Uint8Array = gw.encodePng(6).slice()
const tracks: Track[] = gw.tracks()
const viewport: Viewport = gw.viewport()
const chrom: string = viewport.regions[0].chrom
const read: string = gw.selectedAlign()
configured.delete()

const node: GwplotModule = await createNode({ wasmBinary: new Uint8Array(0) })

// Pointer input beyond press and release
gw.mouseEvent(10, 20, Module.MOUSE_BUTTON_RIGHT, Module.RELEASE, Module.MOD_SHIFT | Module.MOD_CONTROL)
gw.mouseMove(30, 20)
gw.scroll(0, -1)

// @ts-expect-error not a theme
gw.setTheme('blue')
// @ts-expect-error missing the height
new Module.Gw('/data/ref.fa', 1200)
// @ts-expect-error not a method
gw.addBams('/data/sample.bam')
// @ts-expect-error a string, not a number
const frame: number = gw.translationStrand()
// @ts-expect-error not a field
viewport.regions[0].name

export { image, png, tracks, chrom, read, requests, node, frame }
