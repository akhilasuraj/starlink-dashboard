"""Generate small PNG tray indicators with no native drawing dependency."""

from pathlib import Path
import struct
import zlib


COLORS = {
    "healthy": (0, 200, 83), "impaired": (255, 193, 7), "offline": (213, 0, 0),
    "unreachable": (41, 121, 255), "stale": (150, 150, 150),
    "collector-error": (170, 60, 200), "collecting": (90, 90, 90), "unknown": (110, 85, 50),
}


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def icon(color):
    rows = []
    for y in range(16):
        row = bytearray()
        for x in range(16):
            distance = (x - 7.5) ** 2 + (y - 7.5) ** 2
            row.extend((*color, 255) if distance <= 36 else (255, 255, 255, 255)
                       if distance <= 49 else (0, 0, 0, 0))
        rows.append(b"\0" + row)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))


if __name__ == "__main__":
    destination = Path(__file__).resolve().parents[1] / "assets" / "tray"
    destination.mkdir(parents=True, exist_ok=True)
    for name, color in COLORS.items():
        (destination / f"{name}.png").write_bytes(icon(color))
