/**
 * Standalone extractor test — inlines the same logic that lives in
 * electron/services/extract.service.ts so we can run it under plain
 * Node (no Vite/Electron needed). Verifies:
 *
 *   • Reading entries via yauzl
 *   • Manual local-header parsing + raw fs.read of compressed data
 *   • Decompression of methods 0 (stored), 8 (deflate), 93 (zstd via fzstd)
 *
 * Run after generating the source fixture:
 *   python scripts/make-zstd-test-zip.py
 *   node scripts/test-extract-zstd.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const yauzl = require('yauzl')
const { Decompress: ZstdDecompress } = require('fzstd')

const TMP = process.env.TEMP || os.tmpdir()
const SRC_ZIP = path.join(TMP, 'gameverse-zstd-test.zip')

if (!fs.existsSync(SRC_ZIP)) {
  console.error('Source zip not found at', SRC_ZIP)
  console.error('Run: python scripts/make-zstd-test-zip.py')
  process.exit(1)
}

// Expected payloads — must match scripts/make-zstd-test-zip.py
const EXPECTED = {
  'hello-zstd.txt': 'Hello from a ZSTD-compressed entry!\n'.repeat(500),
  'hello-deflate.txt': 'Hello from a Deflate-compressed entry!\n'.repeat(500),
  'hello-stored.txt': 'Stored / no compression payload.\n'.repeat(100),
}

// Mirror of ZstdDecompressStream from extract.service.ts
class ZstdDecompressStream extends Transform {
  constructor() {
    super()
    this.decompressor = new ZstdDecompress((data) => {
      this.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    })
  }
  _transform(chunk, _enc, cb) {
    try { this.decompressor.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false); cb() } catch (e) { cb(e) }
  }
  _flush(cb) {
    try { this.decompressor.push(new Uint8Array(0), true); cb() } catch (e) { cb(e) }
  }
}

function readEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error('open fail'))
      const out = []
      zf.on('entry', (e) => {
        out.push({
          fileName: e.fileName,
          offset: e.relativeOffsetOfLocalHeader,
          compressedSize: e.compressedSize,
          uncompressedSize: e.uncompressedSize,
          compressionMethod: e.compressionMethod,
          isDirectory: /\/$/.test(e.fileName),
        })
        zf.readEntry()
      })
      zf.on('end', () => { zf.close(); resolve(out) })
      zf.on('error', reject)
      zf.readEntry()
    })
  })
}

async function extractEntry(zipPath, entry, destPath) {
  const fd = fs.openSync(zipPath, 'r')
  let fileNameLength, extraFieldLength
  try {
    const hdr = Buffer.alloc(30)
    const n = fs.readSync(fd, hdr, 0, 30, entry.offset)
    if (n !== 30) throw new Error('short header read')
    if (hdr.readUInt32LE(0) !== 0x04034b50) throw new Error('bad signature')
    fileNameLength = hdr.readUInt16LE(26)
    extraFieldLength = hdr.readUInt16LE(28)
  } finally {
    fs.closeSync(fd)
  }
  const dataOffset = entry.offset + 30 + fileNameLength + extraFieldLength
  const dataSize = entry.compressedSize
  if (dataSize === 0) {
    fs.writeFileSync(destPath, Buffer.alloc(0))
    return
  }
  const rs = fs.createReadStream(zipPath, { start: dataOffset, end: dataOffset + dataSize - 1 })
  const ws = fs.createWriteStream(destPath)
  if (entry.compressionMethod === 0) {
    await pipeline(rs, ws)
  } else if (entry.compressionMethod === 8) {
    await pipeline(rs, zlib.createInflateRaw(), ws)
  } else if (entry.compressionMethod === 93) {
    await pipeline(rs, new ZstdDecompressStream(), ws)
  } else {
    rs.destroy(); ws.destroy()
    throw new Error(`Unsupported method ${entry.compressionMethod}`)
  }
}

;(async () => {
  console.log('source zip:', SRC_ZIP, '-', fs.statSync(SRC_ZIP).size, 'bytes')

  const entries = await readEntries(SRC_ZIP)
  console.log('entries:', entries.length)
  entries.forEach(e => console.log('  ', e.fileName, '  method=' + e.compressionMethod, '  size=' + e.uncompressedSize))

  const outDir = fs.mkdtempSync(path.join(TMP, 'extract-test-'))
  console.log('extracting to:', outDir)

  let pass = 0, fail = 0
  for (const entry of entries) {
    const dest = path.join(outDir, entry.fileName)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      await extractEntry(SRC_ZIP, entry, dest)
      const got = fs.readFileSync(dest, 'utf8')
      const want = EXPECTED[entry.fileName]
      if (got === want) {
        console.log(`  ✓ ${entry.fileName}  (${got.length} chars, method=${entry.compressionMethod})`)
        pass++
      } else {
        console.log(`  ✗ ${entry.fileName}  MISMATCH (got ${got.length} chars, expected ${want?.length ?? '?'})`)
        if (want) {
          // Show first divergence point for debugging
          for (let i = 0; i < Math.min(got.length, want.length); i++) {
            if (got[i] !== want[i]) { console.log(`     diverges at byte ${i}: got 0x${got.charCodeAt(i).toString(16)} want 0x${want.charCodeAt(i).toString(16)}`); break }
          }
        }
        fail++
      }
    } catch (e) {
      console.log(`  ✗ ${entry.fileName}  EXTRACTION FAILED: ${e.message}`)
      fail++
    }
  }

  console.log(`\nresults: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
})().catch(e => { console.error('test crashed:', e); process.exit(2) })
