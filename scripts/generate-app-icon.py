from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "assets" / "icons"
SCALE = 4
SIZE = 512


def s(value):
    if isinstance(value, tuple):
        return tuple(int(item * SCALE) for item in value)
    return int(value * SCALE)


def rounded_line(draw, points, fill, width):
    scaled = [s(point) for point in points]
    stroke = s(width)
    draw.line(scaled, fill=fill, width=stroke, joint="curve")
    radius = stroke // 2
    for x, y in (scaled[0], scaled[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def main():
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    canvas = Image.new("RGBA", (s(SIZE), s(SIZE)), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    draw.rounded_rectangle(s((16, 16, 496, 496)), radius=s(112), fill="#202426")
    rounded_line(draw, [(154, 334), (236, 154), (256, 142), (276, 154), (358, 334)], "#F2F0EA", 34)
    rounded_line(draw, [(190, 273), (322, 273)], "#F2F0EA", 30)

    for x, y, color in (
        (133, 148, "#7FA69A"),
        (379, 148, "#9A8F83"),
        (389, 365, "#8495A8"),
    ):
        radius = s(22)
        cx, cy = s(x), s(y)
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color)

    image = canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    image.save(ICON_DIR / "app.png")
    image.save(
        ICON_DIR / "app.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
