"""Generate the extension icons (blue rounded square with a white slash) without any image library."""
import struct, zlib, os, math

def png(width, height, rows):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

def icon(size):
    bg = (37, 99, 235); fg = (255, 255, 255)
    radius = size * 0.22
    thick = size * 0.13
    rows = []
    ss = 4  # supersampling per axis
    for y in range(size):
        row = []
        for x in range(size):
            cov_bg = 0.0; cov_fg = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss; py = y + (sy + 0.5) / ss
                    # rounded square
                    dx = max(radius - px, px - (size - radius), 0)
                    dy = max(radius - py, py - (size - radius), 0)
                    inside = (dx * dx + dy * dy) <= radius * radius
                    if not inside: continue
                    cov_bg += 1
                    # slash from bottom-left to top-right, distance to line y = size - x
                    d = abs(px + py - size) / math.sqrt(2)
                    margin = size * 0.24
                    if d <= thick / 2 and margin < px < size - margin and margin < py < size - margin:
                        cov_fg += 1
            n = ss * ss
            a = cov_bg / n
            f = cov_fg / n
            r = bg[0] * (1 - f) + fg[0] * f
            g = bg[1] * (1 - f) + fg[1] * f
            b = bg[2] * (1 - f) + fg[2] * f
            row += [int(r), int(g), int(b), int(255 * a)]
        rows.append(row)
    return png(size, size, rows)

here = os.path.dirname(os.path.abspath(__file__))
for s in (16, 32, 48, 128):
    with open(os.path.join(here, f"icon{s}.png"), "wb") as f:
        f.write(icon(s))
print("icons written")
