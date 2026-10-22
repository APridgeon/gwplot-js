// fs_bridge.d.mts: TypeScript declarations for fs_bridge.mjs, which puts files from a web
// server into the module's file system for gw to read.

import type { EmscriptenFS } from './gwplot.mjs'

/** Bytes of a file, with its whole size and version. */
export interface RangeResult {
  bytes: Uint8Array
  /** the file's size, from Content-Range */
  size: number
  etag: string | null
}

/** Running totals over every mounted file. */
export interface Totals {
  /** range requests made */
  requests: number
  /** bytes they fetched */
  bytes: number
  /** milliseconds spent waiting for them */
  ms: number
  /** pages read from a page store */
  stored: number
}

/** Where a file's pages are kept between visits (openPageStore). */
export interface PageStore {
  /** Use the store for this version of the file: emptied if it held another. */
  open(etag: string, size: number, pageSize: number): void
  has(number: number): boolean
  get(number: number, length: number): Uint8Array | undefined
  put(number: number, bytes: Uint8Array): void
  /** Make what was put permanent. */
  flush(): void
}

/** What pageStore keeps its pages in: OPFS sync access handles, or anything like them. */
export interface SyncHandle {
  getSize(): number
  read(into: Uint8Array, options: { at: number }): number
  write(data: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  flush(): void
}

export interface MountOptions {
  /** the unit fetched and cached (64 KiB) */
  pageSize?: number
  /** the most asked for at once (8 MiB; match the server's cap) */
  maxRequest?: number
  /** the furthest sequential reads fetch ahead (4 MiB) */
  maxReadahead?: number
  /** pages kept in memory per file (64 MiB) */
  cacheBytes?: number
  /** pages kept between visits (openPageStore), if any */
  store?: PageStore | null
  /** how to fetch bytes [start, end] of the file (xhrRange) */
  fetchRange?(url: string, start: number, end: number): RangeResult
}

/** A mounted file: its size, and a count of the fetches made so far. */
export interface Mount {
  size: number
  requests(): number
}

/** A copy of the running totals (diff two to cost one message). */
export function fetchTotals(): Totals

/** Fetch bytes [start, end] of url with a synchronous range request (Web Workers only). */
export function xhrRange(url: string, start: number, end: number): RangeResult

/** The whole of a small file (an index), with the session cookie. */
export function fetchWhole(url: string): Promise<Uint8Array>

/**
 * A file's pages kept in the browser's origin-private file system (OPFS) between visits.
 * Only for files that are the same for everyone. Null where there's no such storage, or
 * when another tab has this store open.
 */
export function openPageStore(name: string, options?: { maxBytes?: number }): Promise<PageStore | null>

/** The store over three sync access handles (or in-memory stand-ins, for tests). */
export function pageStore(handles: { data: SyncHandle; index: SyncHandle; meta: SyncHandle }, maxBytes?: number): PageStore

/** Write a small file's bytes into the file system at path. */
export function writeFile(FS: EmscriptenFS, path: string, bytes: ArrayBufferView): void

/**
 * Put url in the file system at path as a file read from the server on demand, a range at
 * a time. The server must answer Range requests with 206.
 */
export function mountUrl(FS: EmscriptenFS, path: string, url: string, options?: MountOptions): Mount
