// fs_bridge.mjs: files on a web server, made readable by gw (gwplot-js) in the browser.
//
// gw (htslib) reads files the way it would on disk: seek, read a few kilobytes, seek
// again. mountUrl puts a file in Emscripten's file system whose reads are fetched from
// the server as HTTP range requests (it must answer them 206) and kept in a cache. The
// reads are synchronous -- gw waits for each one -- which browsers allow only in a Web
// Worker, and is why the module runs in one.
//
// Small files (the indexes) are better fetched whole up front: fetchWhole. Files that are
// the same for everyone (the reference, the annotation) can also be kept between visits,
// in the browser's own storage: openPageStore.
//
// fetchRange is swappable so the same code runs under Node in tests (tests/smoke.mjs).

const EIO = 29 // Emscripten's errno for an I/O error

// Running totals over every mounted file, for the ?perf=1 overlay: range requests made,
// bytes they fetched, milliseconds gw spent waiting for them, and pages read from a store.
const totals = { requests: 0, bytes: 0, ms: 0, stored: 0 }
/** A copy of the running totals (diff two to cost one message). */
export const fetchTotals = () => ({ ...totals })

/**
 * Fetch bytes [start, end] of ``url`` with a synchronous range request (Web Workers only).
 * Same-origin, so the browser sends its cookies (a login session, say) and the server
 * can decide who may read the file.
 * @returns {{bytes: Uint8Array, size: number, etag: string | null}}
 */
export function xhrRange(url, start, end) {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.responseType = 'arraybuffer'
  xhr.setRequestHeader('Range', `bytes=${start}-${end}`)
  xhr.send(null)
  if (xhr.status !== 206) throw new Error(`${url}: expected 206 for bytes ${start}-${end}, got ${xhr.status}`)
  const total = /\/(\d+)$/.exec(xhr.getResponseHeader('Content-Range') || '')
  return {
    bytes: new Uint8Array(xhr.response),
    size: total ? Number(total[1]) : NaN,
    etag: xhr.getResponseHeader('ETag'),
  }
}

/** The whole of a small file (an index), with the session cookie. */
export async function fetchWhole(url) {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * A file's pages kept in the browser's origin-private file system (OPFS), so they needn't
 * be fetched again on a later visit. For files that are the same for everyone -- never a
 * sample's reads, which the browser must not keep. Null where there's no such storage, or
 * when another tab has this store open (a store is opened by one worker at a time).
 *
 * In ``gwplot-js-cache/<name>/``: ``data`` (pages, appended as fetched), ``index`` (where each
 * page is in data: a float64 per page, its offset + 1, 0 for none) and ``meta`` (the file's
 * ETag, size and page size; when they change, the store starts again empty).
 */
export async function openPageStore(name, { maxBytes = 4 * 1024 ** 3 } = {}) {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
  try {
    const root = await navigator.storage.getDirectory()
    const cache = await root.getDirectoryHandle('gwplot-js-cache', { create: true })
    const dir = await cache.getDirectoryHandle(name, { create: true })
    const open = async (file) => (await dir.getFileHandle(file, { create: true })).createSyncAccessHandle()
    const [data, index, meta] = await Promise.all(['data', 'index', 'meta'].map(open))
    return pageStore({ data, index, meta }, maxBytes)
  } catch (error) {
    console.warn(`[gwplot-js] not keeping ${name} between visits:`, error)
    return null
  }
}

/** The store over three sync access handles (anything with their read/write/getSize/
 *  truncate/flush), so tests can give it in-memory ones. */
export function pageStore({ data, index, meta }, maxBytes = Infinity) {
  let offsets = new Float64Array(0)
  const pending = [] // pages written to data but not yet to the index (see flush)
  const readMeta = () => {
    const bytes = new Uint8Array(meta.getSize())
    meta.read(bytes, { at: 0 })
    try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return {} }
  }
  return {
    /** Use the store for this version of the file: emptied if it held another. */
    open(etag, size, pageSize) {
      const info = readMeta()
      if (info.etag !== etag || info.size !== size || info.pageSize !== pageSize) {
        data.truncate(0)
        index.truncate(0)
        meta.truncate(0)
        meta.write(new TextEncoder().encode(JSON.stringify({ etag, size, pageSize })), { at: 0 })
        meta.flush()
      }
      offsets = new Float64Array(Math.ceil(size / pageSize))
      index.read(new Uint8Array(offsets.buffer, 0, Math.min(index.getSize(), offsets.byteLength)), { at: 0 })
    },
    has: (number) => offsets[number] > 0,
    get(number, length) {
      if (!(offsets[number] > 0)) return undefined
      const bytes = new Uint8Array(length)
      return data.read(bytes, { at: offsets[number] - 1 }) === length ? bytes : undefined
    },
    put(number, bytes) {
      if (offsets[number] > 0 || pending.some(([n]) => n === number)) return
      const at = data.getSize()
      if (at + bytes.length > maxBytes) return // full: keep what's there
      data.write(bytes, { at })
      pending.push([number, at])
    },
    /** Make what was put permanent: the pages, and only then the index pointing at them. */
    flush() {
      if (pending.length === 0) return
      data.flush()
      for (const [number, at] of pending.splice(0)) {
        offsets[number] = at + 1
        index.write(new Uint8Array(offsets.buffer, number * 8, 8), { at: number * 8 })
      }
      index.flush()
    },
  }
}

/** Make the parent directories of ``path`` in Emscripten's file system. */
function makeParents(FS, path) {
  const parts = path.split('/').slice(1, -1)
  let dir = ''
  for (const part of parts) {
    dir += '/' + part
    try { FS.mkdir(dir) } catch { /* already there */ }
  }
}

/** Write a small file's bytes into the file system at ``path``. */
export function writeFile(FS, path, bytes) {
  makeParents(FS, path)
  FS.writeFile(path, bytes)
}

/**
 * Put ``url`` in the file system at ``path`` as a file read from the server on demand.
 *
 * Reads are fetched in as few requests as possible, since each one is a round trip that gw
 * waits for: a read of many pages (htslib loading a CRAM slice's reference can ask for
 * megabytes at once) is one request per run of missing pages, up to maxRequest; and reads
 * that carry on where the last one ended (htslib working through BGZF blocks) fetch ahead,
 * twice as far each time up to maxReadahead, back to a single page after a seek.
 *
 * @param {object} FS the module's FS
 * @param {object} [options]
 * @param {number} [options.pageSize] the unit fetched and cached (64 KiB)
 * @param {number} [options.maxRequest] the most asked for at once (8 MiB; match the server's cap)
 * @param {number} [options.maxReadahead] the furthest sequential reads fetch ahead (4 MiB)
 * @param {number} [options.cacheBytes] pages kept in memory per file (64 MiB)
 * @param {object} [options.store] pages kept between visits (openPageStore), if any
 * @param {Function} [options.fetchRange] (url, start, end) => {bytes, size, etag}
 * @returns {{size: number, requests: () => number}} its size, and a count of the fetches
 *   made so far (for tests)
 */
export function mountUrl(FS, path, url, options = {}) {
  const pageSize = options.pageSize ?? 64 * 1024
  const maxRequest = options.maxRequest ?? 8 * 1024 * 1024
  const maxReadahead = options.maxReadahead ?? 4 * 1024 * 1024
  const maxPages = Math.max(1, Math.floor((options.cacheBytes ?? 64 * 1024 * 1024) / pageSize))
  const fetchRange = options.fetchRange ?? xhrRange
  const pages = new Map() // page number -> bytes, oldest first (re-inserted on use)
  let requests = 0
  let readEnd = -1 // where the last read ended, to spot sequential reads
  let readahead = 0 // bytes fetched beyond a sequential read

  const timedFetch = (start, end) => {
    const began = performance.now()
    const got = fetchRange(url, start, end)
    requests += 1
    totals.requests += 1
    totals.bytes += got.bytes.length
    totals.ms += performance.now() - began
    return got
  }

  // The first page tells us the file's size (and is what htslib reads first anyway).
  const first = timedFetch(0, pageSize - 1)
  const size = first.size
  const etag = first.etag
  if (!Number.isFinite(size)) throw new Error(`${url}: the server did not say how big it is`)
  const lastPage = Math.floor((size - 1) / pageSize)
  const pagesPerRequest = Math.max(1, Math.floor(maxRequest / pageSize))
  // a store needs the version of the file, to know when what it holds is out of date
  const store = etag ? options.store ?? null : null
  store?.open(etag, size, pageSize)
  const pageLength = (number) => Math.min(pageSize, size - number * pageSize)
  const have = (number) => pages.has(number) || (store?.has(number) ?? false)

  function remember(number, bytes) {
    pages.set(number, bytes)
    if (pages.size > maxPages) pages.delete(pages.keys().next().value)
  }
  remember(0, first.bytes)
  store?.put(0, first.bytes.subarray(0, pageLength(0)))
  store?.flush()

  function cached(number) {
    let bytes = pages.get(number)
    if (bytes !== undefined) {
      pages.delete(number) // most recently used goes last
      pages.set(number, bytes)
    } else if (store) {
      bytes = store.get(number, pageLength(number))
      if (bytes !== undefined) {
        totals.stored += 1
        remember(number, bytes)
      }
    }
    return bytes
  }

  /** Fetch pages from..to (all missing; at most maxRequest of them) and cache them. */
  function fetchPages(from, to) {
    const start = from * pageSize
    const end = Math.min((to + 1) * pageSize, size) - 1
    const bytes = new Uint8Array(end - start + 1)
    // The server may send less than asked (it may cap a range's length), so keep asking.
    for (let filled = 0; filled < bytes.length;) {
      const got = timedFetch(start + filled, end)
      if (etag && got.etag && got.etag !== etag) {
        throw new Error(`${url} changed on the server while it was open`)
      }
      if (got.bytes.length === 0) throw new Error(`${url}: empty range at ${start + filled}`)
      bytes.set(got.bytes, filled)
      filled += got.bytes.length
    }
    for (let number = from; number <= to; number++) {
      const page = bytes.subarray((number - from) * pageSize, (number - from + 1) * pageSize)
      remember(number, page)
      store?.put(number, page)
    }
    store?.flush()
    return bytes
  }

  /** Copy ``wanted`` bytes at ``position`` into ``buffer`` at ``offset``. */
  function read(buffer, offset, position, wanted) {
    const firstWanted = Math.floor(position / pageSize)
    const lastWanted = Math.floor((position + wanted - 1) / pageSize)
    readahead = position === readEnd ? Math.min(Math.max(readahead * 2, pageSize), maxReadahead) : 0
    readEnd = position + wanted
    const fetchTo = Math.min(lastWanted + Math.ceil(readahead / pageSize), lastPage)
    let number = firstWanted
    while (number <= lastWanted) {
      const spanStart = number * pageSize
      let bytes = cached(number)
      if (bytes === undefined) {
        // the run of missing pages from here (and any readahead past the read's end), one
        // request's worth: cached pages are views of what was fetched, so a fetch stays in
        // memory while any of its pages is cached; keep each to maxRequest
        let to = number
        while (to < fetchTo && to - number + 1 < pagesPerRequest && !have(to + 1)) to++
        bytes = fetchPages(number, to)
        number = to + 1
      } else {
        number += 1
      }
      // the part of these bytes the read wants
      const from = Math.max(position, spanStart)
      const until = Math.min(position + wanted, spanStart + bytes.length)
      if (until > from) buffer.set(bytes.subarray(from - spanStart, until - spanStart), offset + (from - position))
    }
  }

  makeParents(FS, path)
  const slash = path.lastIndexOf('/')
  const node = FS.createFile(path.slice(0, slash) || '/', path.slice(slash + 1), null, true, false)
  // MEMFS reports a file's size (stat, SEEK_END) from usedBytes.
  Object.defineProperty(node, 'usedBytes', { get: () => size })
  node.stream_ops = {
    ...node.stream_ops,
    read(stream, buffer, offset, length, position) {
      if (position >= size) return 0
      const wanted = Math.min(length, size - position)
      try {
        read(buffer, offset, position, wanted)
      } catch (error) {
        console.error('[gwplot-js] reading', url, error)
        throw new FS.ErrnoError(EIO)
      }
      return wanted
    },
    write() {
      throw new FS.ErrnoError(EIO) // read-only
    },
  }
  return { size, requests: () => requests }
}
