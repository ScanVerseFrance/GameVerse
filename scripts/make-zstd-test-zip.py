"""
Build a minimal valid .zip containing exactly one entry compressed with
ZSTD (method 93), then a second entry compressed with Deflate (method 8)
so we exercise the multi-method code path.

The standard library `zipfile` doesn't expose ZSTD, so we craft the
local-file-header + central-directory bytes by hand. Output goes to
%TEMP%/gameverse-zstd-test.zip and prints the path.
"""
import os, struct, tempfile, zlib, zstandard

TMP = os.environ.get("TEMP", "/tmp")
OUT = os.path.join(TMP, "gameverse-zstd-test.zip")

ENTRIES = [
    # (filename, method, payload)
    ("hello-zstd.txt", 93, b"Hello from a ZSTD-compressed entry!\n" * 500),
    ("hello-deflate.txt", 8, b"Hello from a Deflate-compressed entry!\n" * 500),
    ("hello-stored.txt", 0, b"Stored / no compression payload.\n" * 100),
]

def compress(method, data):
    if method == 0:
        return data
    if method == 8:
        # Raw deflate (no zlib wrapper) — matches what PKZIP writes.
        co = zlib.compressobj(zlib.Z_BEST_COMPRESSION, zlib.DEFLATED, -15)
        return co.compress(data) + co.flush()
    if method == 93:
        cctx = zstandard.ZstdCompressor(level=3)
        return cctx.compress(data)
    raise ValueError(f"unsupported method {method}")

def crc32(data):
    return zlib.crc32(data) & 0xFFFFFFFF

records = []
central = bytearray()
local = bytearray()

for name, method, payload in ENTRIES:
    crc = crc32(payload)
    compressed = compress(method, payload)
    name_bytes = name.encode("utf-8")
    offset = len(local)

    # Local file header (30 bytes + name + extra)
    local += struct.pack(
        "<IHHHHHIIIHH",
        0x04034b50,  # signature
        20,           # version needed
        0,            # flags
        method,       # compression method
        0, 0,         # last mod time/date
        crc,
        len(compressed),
        len(payload),
        len(name_bytes),
        0,            # extra field length
    )
    local += name_bytes
    local += compressed

    # Central directory entry (46 bytes + name + extra + comment)
    central += struct.pack(
        "<IHHHHHHIIIHHHHHII",
        0x02014b50,  # central dir signature
        20,           # version made by
        20,           # version needed
        0,            # flags
        method,
        0, 0,         # mod time/date
        crc,
        len(compressed),
        len(payload),
        len(name_bytes),
        0,            # extra
        0,            # comment
        0,            # disk num
        0,            # internal attrs
        0,            # external attrs
        offset,
    )
    central += name_bytes

central_offset = len(local)
central_size = len(central)

eocd = struct.pack(
    "<IHHHHIIH",
    0x06054b50,  # EOCD signature
    0, 0,         # disk numbers
    len(ENTRIES),
    len(ENTRIES),
    central_size,
    central_offset,
    0,            # comment length
)

with open(OUT, "wb") as f:
    f.write(local)
    f.write(central)
    f.write(eocd)

print(OUT)
print(f"  size: {os.path.getsize(OUT)} bytes")
print(f"  entries: {len(ENTRIES)}")
for n, m, p in ENTRIES:
    print(f"    {n}  method={m}  uncompressed={len(p)}")
