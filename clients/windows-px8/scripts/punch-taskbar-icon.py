#!/usr/bin/env python3
"""Knock the solid black tile out of the Windows client icon.

The source mark sits on a hard square. Windows then shows that square on the
taskbar. This keeps the T and play triangle and makes the tile transparent.
"""
from __future__ import annotations

import struct
import zlib
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "icon-src.png"
ICON_DIR = ROOT / "src-tauri" / "icons"


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png(path: Path) -> tuple[int, int, bytearray]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    width = height = color = None
    raw = b""
    offset = 8
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        name = data[offset + 4 : offset + 8]
        chunk = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if name == b"IHDR":
            width, height, depth, color, *_ = struct.unpack(">IIBBBBB", chunk)
            if depth != 8 or color not in (2, 6):
                raise SystemExit(f"{path} must be 8-bit RGB or RGBA")
        elif name == b"IDAT":
            raw += chunk
        elif name == b"IEND":
            break
    if width is None or height is None or color is None:
        raise SystemExit(f"{path} is missing IHDR")
    rows = zlib.decompress(raw)
    bpp = 4 if color == 6 else 3
    stride = width * bpp
    expected = height * (stride + 1)
    if len(rows) < expected:
        raise SystemExit(f"{path} has truncated pixel data")
    prev = bytearray(stride)
    rgba = bytearray(width * height * 4)
    src = 0
    dst = 0
    for _ in range(height):
        filt = rows[src]
        src += 1
        cur = bytearray(rows[src : src + stride])
        src += stride
        if filt == 1:
            for i in range(stride):
                cur[i] = (cur[i] + (cur[i - bpp] if i >= bpp else 0)) & 255
        elif filt == 2:
            for i in range(stride):
                cur[i] = (cur[i] + prev[i]) & 255
        elif filt == 3:
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + ((left + prev[i]) // 2)) & 255
        elif filt == 4:
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                up_left = prev[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + paeth(left, prev[i], up_left)) & 255
        elif filt != 0:
            raise SystemExit(f"{path} uses unsupported PNG filter {filt}")
        prev = cur
        if color == 6:
            rgba[dst : dst + stride] = cur
            dst += stride
        else:
            for i in range(0, stride, 3):
                rgba[dst : dst + 4] = bytes((cur[i], cur[i + 1], cur[i + 2], 255))
                dst += 4
    return width, height, rgba


def write_png(path: Path, width: int, height: int, pixels: bytes) -> None:
    def chunk(name: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + name + body + struct.pack(">I", zlib.crc32(name + body) & 0xFFFFFFFF)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def is_tile(pixels: bytearray, index: int) -> bool:
    r, g, b, a = pixels[index : index + 4]
    return a > 0 and r < 22 and g < 22 and b < 22


def knock_out(width: int, height: int, pixels: bytearray) -> None:
    seen = bytearray(width * height)
    queue = deque()

    def push(x: int, y: int) -> None:
        if 0 <= x < width and 0 <= y < height:
            queue.append((x, y))

    for x in range(width):
        push(x, 0)
        push(x, height - 1)
    for y in range(height):
        push(0, y)
        push(width - 1, y)
    while queue:
        x, y = queue.popleft()
        i = y * width + x
        if seen[i]:
            continue
        seen[i] = 1
        px = i * 4
        if not is_tile(pixels, px):
            continue
        pixels[px : px + 4] = b"\x00\x00\x00\x00"
        knock_out.cleared += 1
        push(x - 1, y)
        push(x + 1, y)
        push(x, y - 1)
        push(x, y + 1)


knock_out.cleared = 0


def scale(width: int, height: int, pixels: bytearray, size: int) -> bytes:
    if width == size and height == size:
        return bytes(pixels)
    out = bytearray(size * size * 4)
    for y in range(size):
        y0 = (y * height) // size
        y1 = max(y0 + 1, ((y + 1) * height) // size)
        for x in range(size):
            x0 = (x * width) // size
            x1 = max(x0 + 1, ((x + 1) * width) // size)
            r = g = b = a = count = 0
            for sy in range(y0, y1):
                for sx in range(x0, x1):
                    src = (sy * width + sx) * 4
                    alpha = pixels[src + 3]
                    r += pixels[src] * alpha
                    g += pixels[src + 1] * alpha
                    b += pixels[src + 2] * alpha
                    a += alpha
                    count += 1
            dst = (y * size + x) * 4
            if a:
                out[dst] = min(255, r // a)
                out[dst + 1] = min(255, g // a)
                out[dst + 2] = min(255, b // a)
                out[dst + 3] = min(255, a // count)
    return bytes(out)


def write_ico(path: Path, images: list[tuple[int, bytes]]) -> None:
    entries = []
    payload = b""
    offset = 6 + 16 * len(images)
    for size, png in images:
        entry = struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(png),
            offset,
        )
        entries.append(entry)
        payload += png
        offset += len(png)
    path.write_bytes(struct.pack("<HHH", 0, 1, len(images)) + b"".join(entries) + payload)


def main() -> None:
    width, height, pixels = read_png(SRC)
    knock_out.cleared = 0
    knock_out(width, height, pixels)
    if knock_out.cleared < 100:
        raise SystemExit(f"tile punch-out failed ({knock_out.cleared} pixels)")
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    master = ICON_DIR / "icon.png"
    write_png(master, width, height, pixels)
    sizes = {
        32: ICON_DIR / "32x32.png",
        128: ICON_DIR / "128x128.png",
        256: ICON_DIR / "128x128@2x.png",
    }
    pngs = []
    for size in (256, 128, 32):
        scaled = scale(width, height, pixels, size)
        dest = sizes.get(size)
        if dest:
            write_png(dest, size, size, scaled)
            pngs.append((size, dest.read_bytes()))
        else:
            tmp = ICON_DIR / "_ico-256.png"
            write_png(tmp, size, size, scaled)
            pngs.append((size, tmp.read_bytes()))
            tmp.unlink()
    write_ico(ICON_DIR / "icon.ico", pngs)
    print(f"wrote transparent taskbar icons from {SRC.name}")


if __name__ == "__main__":
    main()
