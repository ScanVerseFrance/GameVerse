/**
 * Zip extraction service — two strategies, picked per-call by the user
 * from the "Dezip" modal:
 *
 *   • SAFE        — yauzl streaming extraction. The .zip stays untouched
 *                   on disk until extraction completes, then is deleted
 *                   in one shot. Peak disk usage: zip + extracted.
 *                   Robust: a crash mid-extraction leaves the .zip intact
 *                   so the user can retry.
 *
 *   • PROGRESSIVE — Reads the central directory once via yauzl, then
 *                   manually parses each entry's local file header and
 *                   streams the compressed data straight off disk. After
 *                   each entry (in offset-descending order) the zip is
 *                   truncated to drop the bytes we no longer need.
 *                   Peak disk usage ~= extracted only.
 *                   Risk: a crash mid-extraction destroys the .zip
 *                   (truncated, no way to recover the unextracted entries).
 *
 * Both modes:
 *   - Sanitise destination paths so a malicious "../../etc/passwd" entry
 *     can't escape the target folder.
 *   - Emit progress callbacks the IPC layer relays to the renderer.
 *   - Support compression methods Stored (0), Deflate (8), and ZSTD (93
 *     via the pure-JS `fzstd` library — heavily used by modern repackers
 *     and the AnkerGames pre-installed bundles). Other methods (LZMA,
 *     BZip2, XZ) are rarer; they raise an explicit error rather than
 *     corrupting silently.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { Decompress as ZstdDecompress } from 'fzstd'

export type ExtractMode = 'safe' | 'progressive'

export interface ExtractProgress {
  /** Bytes of uncompressed content written to disk so far. */
  extractedBytes: number
  /** Total uncompressed content across every entry in the zip. */
  totalBytes: number
  /** Relative path of the entry just written (UI surfaces this as the
   *  "Extraction de …" line). */
  currentFile: string
  /** Live size of the source .zip on disk. Identical to the original
   *  size in SAFE mode (until the final cleanup); shrinks per-entry in
   *  PROGRESSIVE mode. */
  zipBytesRemaining: number
}

export interface ExtractOptions {
  mode: ExtractMode
  onProgress?: (p: ExtractProgress) => void
  /** Cooperative cancellation. When set to true the next entry-boundary
   *  check causes the extractor to throw an `AbortError`. */
  signal?: { aborted: boolean }
}

interface EntryInfo {
  fileName: string
  offset: number
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  isDirectory: boolean
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const COMPRESSION_STORED = 0
const COMPRESSION_DEFLATE = 8
/** Zstandard. ZIP spec assigned method 93 to ZSTD; modern .zip writers
 *  (especially repacker tooling and AnkerGames' pre-installed bundles)
 *  use it heavily because it's ~30% faster than Deflate at higher
 *  compression ratios. Node's built-in zlib doesn't support it; we
 *  decompress via the pure-JS `fzstd` library which doesn't need any
 *  native build step. */
const COMPRESSION_ZSTD = 93

/** Adapt fzstd's push-based `Decompress` class into a Node Transform
 *  stream so we can drop it into the same `pipeline(...)` flow we use
 *  for `zlib.createInflateRaw()`. The fzstd decompressor calls our
 *  `ondata` callback whenever a chunk of decompressed bytes is ready —
 *  we forward those to the readable side of the Transform. */
class ZstdDecompressStream extends Transform {
  private decompressor: ZstdDecompress

  constructor() {
    super()
    this.decompressor = new ZstdDecompress((data, _final) => {
      // `data` is a Uint8Array — wrap in a Node Buffer for downstream
      // consumers that may expect Buffer specifically.
      this.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    })
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback): void {
    try {
      this.decompressor.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false)
      cb()
    } catch (e) {
      cb(e as Error)
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      // Signal end-of-stream so the decompressor flushes any buffered output.
      this.decompressor.push(new Uint8Array(0), true)
      cb()
    } catch (e) {
      cb(e as Error)
    }
  }
}

// ────────────────────────── helpers ──────────────────────────

/** Read the central directory exactly once via yauzl and collect every
 *  entry's metadata. After this the file handle is closed and we never
 *  use yauzl again — the rest of the work is offset arithmetic. */
function readEntries(zipPath: string): Promise<EntryInfo[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('Failed to open zip'))
      const entries: EntryInfo[] = []
      zipfile.on('entry', (e: yauzl.Entry) => {
        entries.push({
          fileName: e.fileName,
          offset: e.relativeOffsetOfLocalHeader,
          compressedSize: e.compressedSize,
          uncompressedSize: e.uncompressedSize,
          compressionMethod: e.compressionMethod,
          isDirectory: /\/$/.test(e.fileName),
        })
        zipfile.readEntry()
      })
      zipfile.on('end', () => {
        zipfile.close()
        resolve(entries)
      })
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

/** Refuse to extract any entry whose resolved destination escapes
 *  `targetFolder` — guards against zip-slip / "../../../etc/passwd" attacks. */
function sanitiseTarget(targetFolder: string, fileName: string): string | null {
  const cleanName = fileName.replace(/\\/g, '/')
  const dest = path.resolve(targetFolder, cleanName)
  const root = path.resolve(targetFolder) + path.sep
  if (dest !== path.resolve(targetFolder) && !dest.startsWith(root)) return null
  return dest
}

function safeStatSize(p: string): number {
  try {
    return fs.statSync(p).size
  } catch {
    return 0
  }
}

function ensureAbortable(signal: ExtractOptions['signal']): void {
  if (signal?.aborted) {
    const err = new Error('Extraction aborted')
    err.name = 'AbortError'
    throw err
  }
}

// ────────────────────────── SAFE mode ──────────────────────────

/**
 * Streaming extraction — the .zip is left untouched throughout and
 * removed at the end. This is the default the dialog recommends
 * because a crash mid-extraction leaves the .zip recoverable.
 *
 * We use the same hand-rolled `extractEntryManually` as PROGRESSIVE
 * mode rather than `yauzl.openReadStream` because yauzl only knows how
 * to decompress Deflate/Stored entries — modern zips (especially the
 * AnkerGames pre-installed bundles) frequently use ZSTD (method 93)
 * which we handle via `fzstd`. Going through one extractor for both
 * modes also removes a whole class of "works in SAFE but not PROGRESSIVE"
 * surprises.
 */
export async function extractZipSafe(
  zipPath: string,
  targetFolder: string,
  opts: ExtractOptions
): Promise<void> {
  fs.mkdirSync(targetFolder, { recursive: true })
  const entries = await readEntries(zipPath)
  const totalBytes = entries.reduce((s, e) => s + e.uncompressedSize, 0)
  const initialZipSize = safeStatSize(zipPath)
  let extracted = 0

  // Extract entries in their physical order so reads are sequential on
  // disk (better OS-level caching). Doesn't matter for correctness.
  const sorted = [...entries].sort((a, b) => a.offset - b.offset)

  for (const entry of sorted) {
    ensureAbortable(opts.signal)
    const dest = sanitiseTarget(targetFolder, entry.fileName)
    if (!dest) continue

    if (entry.isDirectory) {
      try {
        fs.mkdirSync(dest, { recursive: true })
      } catch {
        /* ignore */
      }
    } else {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
      } catch {
        /* ignore */
      }
      await extractEntryManually(zipPath, entry, dest)
    }

    extracted += entry.uncompressedSize
    opts.onProgress?.({
      extractedBytes: extracted,
      totalBytes,
      currentFile: entry.fileName,
      zipBytesRemaining: initialZipSize, // unchanged in SAFE mode
    })
  }

  // Final cleanup — remove the source .zip now that everything is
  // safely on disk. Best-effort: a failure here only means the user
  // has to delete it by hand.
  try {
    fs.unlinkSync(zipPath)
  } catch {
    /* leave it */
  }
  opts.onProgress?.({
    extractedBytes: totalBytes,
    totalBytes,
    currentFile: '',
    zipBytesRemaining: 0,
  })
}

// ────────────────────────── PROGRESSIVE mode ──────────────────────────

/**
 * In-place shrink extraction. After yauzl reads the central directory
 * we never touch the lib again — we sort entries by file offset
 * DESCENDING, parse each local file header by hand, stream the
 * compressed data through zlib if needed, then `truncateSync` the zip
 * down to the entry's offset. The .zip visibly shrinks during the run.
 */
export async function extractZipProgressive(
  zipPath: string,
  targetFolder: string,
  opts: ExtractOptions
): Promise<void> {
  fs.mkdirSync(targetFolder, { recursive: true })
  const entries = await readEntries(zipPath)
  const totalBytes = entries.reduce((s, e) => s + e.uncompressedSize, 0)
  let extracted = 0

  // Sort by physical offset, last entry first. Truncating at entry.offset
  // after extraction lops off the entry we just consumed AND everything
  // past it (which we already extracted in earlier iterations, plus the
  // central directory the first time around — that's why we can't touch
  // yauzl anymore from here on).
  const sorted = [...entries].sort((a, b) => b.offset - a.offset)

  for (const entry of sorted) {
    ensureAbortable(opts.signal)
    const dest = sanitiseTarget(targetFolder, entry.fileName)
    if (dest) {
      if (entry.isDirectory) {
        try {
          fs.mkdirSync(dest, { recursive: true })
        } catch {
          /* ignore */
        }
      } else {
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true })
        } catch {
          /* ignore */
        }
        await extractEntryManually(zipPath, entry, dest)
      }
    }

    extracted += entry.uncompressedSize

    // Shrink the zip. Failure here is not fatal — the entry IS already
    // extracted; worst case the .zip stays slightly larger than needed.
    try {
      fs.truncateSync(zipPath, entry.offset)
    } catch {
      /* leave it */
    }

    opts.onProgress?.({
      extractedBytes: extracted,
      totalBytes,
      currentFile: entry.fileName,
      zipBytesRemaining: safeStatSize(zipPath),
    })
  }

  // Drop the (now near-empty) zip. Anything left is just the very first
  // entry's local-header sliver if our truncation missed by a few bytes.
  try {
    fs.unlinkSync(zipPath)
  } catch {
    /* leave it */
  }
  opts.onProgress?.({
    extractedBytes: totalBytes,
    totalBytes,
    currentFile: '',
    zipBytesRemaining: 0,
  })
}

/**
 * Hand-rolled local file header parser. Reads exactly the bytes we need
 * (30-byte fixed header + variable filename + extra field), then streams
 * the compressed data via `fs.createReadStream` with a precise byte range
 * so we never load the whole entry into memory.
 *
 * Trusts `entry.compressedSize` from the central directory rather than
 * the local header value (the local one can be 0xFFFFFFFF for zip64
 * entries or 0 when a trailing data-descriptor is used).
 */
async function extractEntryManually(
  zipPath: string,
  entry: EntryInfo,
  destPath: string
): Promise<void> {
  // Read the fixed 30-byte local file header.
  const fd = fs.openSync(zipPath, 'r')
  let fileNameLength: number
  let extraFieldLength: number
  try {
    const headerBuf = Buffer.alloc(30)
    const bytesRead = fs.readSync(fd, headerBuf, 0, 30, entry.offset)
    if (bytesRead !== 30) {
      throw new Error(`Short local header read at offset ${entry.offset}`)
    }
    if (headerBuf.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`Invalid local header signature at offset ${entry.offset}`)
    }
    fileNameLength = headerBuf.readUInt16LE(26)
    extraFieldLength = headerBuf.readUInt16LE(28)
  } finally {
    fs.closeSync(fd)
  }

  const dataOffset = entry.offset + 30 + fileNameLength + extraFieldLength
  const dataSize = entry.compressedSize
  if (dataSize === 0) {
    // Empty file — just touch the destination.
    fs.writeFileSync(destPath, Buffer.alloc(0))
    return
  }

  const readStream = fs.createReadStream(zipPath, {
    start: dataOffset,
    end: dataOffset + dataSize - 1,
  })
  const writeStream = fs.createWriteStream(destPath)

  if (entry.compressionMethod === COMPRESSION_STORED) {
    await pipeline(readStream, writeStream)
  } else if (entry.compressionMethod === COMPRESSION_DEFLATE) {
    await pipeline(readStream, zlib.createInflateRaw(), writeStream)
  } else if (entry.compressionMethod === COMPRESSION_ZSTD) {
    await pipeline(readStream, new ZstdDecompressStream(), writeStream)
  } else {
    // Close streams before throwing so the destination file isn't left
    // half-open on Windows.
    readStream.destroy()
    writeStream.destroy()
    try {
      fs.unlinkSync(destPath)
    } catch {
      /* ignore */
    }
    throw new Error(
      `Unsupported compression method ${entry.compressionMethod} for ${entry.fileName}`
    )
  }
}

// ────────────────────────── public dispatcher ──────────────────────────

export async function extractZip(
  zipPath: string,
  targetFolder: string,
  opts: ExtractOptions
): Promise<void> {
  if (!fs.existsSync(zipPath)) throw new Error('Zip file not found')
  const stat = fs.statSync(zipPath)
  if (!stat.isFile()) throw new Error('Zip path is not a file')
  if (opts.mode === 'progressive') {
    return extractZipProgressive(zipPath, targetFolder, opts)
  }
  return extractZipSafe(zipPath, targetFolder, opts)
}
