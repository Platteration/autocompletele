"""Generate actle's blue tile with a lowercase a and caret without any image library."""
import struct, zlib, os

def png(width, height, rows):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

def icon(size):
    bg = (26, 95, 208); fg = (255, 255, 255)
    radius = size * 0.12
    rows = []
    ss = 4  # supersampling per axis
    for y in range(size):
        row = []
        for x in range(size):
            cov_bg = 0.0; cov_fg = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss; py = y + (sy + 0.5) / ss
                    # square tile with slightly rounded corners
                    dx = max(radius - px, px - (size - radius), 0)
                    dy = max(radius - py, py - (size - radius), 0)
                    inside = (dx * dx + dy * dy) <= radius * radius
                    if not inside: continue
                    cov_bg += 1
                    # A single-storey lowercase a, followed by an insertion caret.
                    # The normalized grid keeps the bowl open and the caret one
                    # pixel wide at the smallest, 16px toolbar size.
                    gx = px / size * 16; gy = py / size * 16
                    distance = (gx - 6.5) ** 2 + (gy - 8.5) ** 2
                    bowl = 1.75 ** 2 <= distance <= 3.5 ** 2
                    stem = 8.5 <= gx <= 10 and 5 <= gy <= 12
                    caret = 12 <= gx <= 13 and 4 <= gy <= 12
                    if bowl or stem or caret:
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
