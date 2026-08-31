"""Generate simple PWA icons."""
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("PIL not available")
    raise SystemExit(1)

icons_dir = Path(__file__).resolve().parent.parent / "icons"
icons_dir.mkdir(exist_ok=True)

for size in (192, 512):
    img = Image.new("RGBA", (size, size), (15, 118, 110, 255))
    draw = ImageDraw.Draw(img)
    margin = size // 6
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 8,
        fill=(20, 184, 166, 255),
    )
    cx, cy = size // 2, size // 2
    bw = size // 3
    points = [
        (cx, cy - bw // 2),
        (cx - bw // 3, cy),
        (cx, cy),
        (cx + bw // 3, cy + bw // 2),
        (cx, cy + bw // 4),
        (cx + bw // 4, cy - bw // 6),
    ]
    draw.polygon(points, fill=(255, 255, 255, 255))
    img.save(icons_dir / f"icon-{size}.png")
    print(f"Created icon-{size}.png")
