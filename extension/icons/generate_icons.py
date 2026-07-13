#!/usr/bin/env python3
"""Generate simple placeholder PNG icons (solid color square with a lighter inner square) using only stdlib."""
import struct
import zlib
import os

SIZES = [16, 32, 48, 128]
BG = (0x00, 0x66, 0xCC)  # Hermes blue
FG = (0xFF, 0xFF, 0xFF)  # white inner mark

def make_png(size):
    rows = []
    margin = max(1, size // 4)
    for y in range(size):
        row = bytearray()
        row.append(0)  # no filter
        for x in range(size):
            if margin <= x < size - margin and margin <= y < size - margin:
                r, g, b = FG
            else:
                r, g, b = BG
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")

if __name__ == "__main__":
    out_dir = os.path.dirname(os.path.abspath(__file__))
    for size in SIZES:
        data = make_png(size)
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(data)
        print(f"wrote {path} ({len(data)} bytes)")
