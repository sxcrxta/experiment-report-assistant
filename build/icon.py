#!/usr/bin/env python3
"""앱 아이콘을 그린다 ([Q-31]).

    python3 build/icon.py        →  build/icon.icns (와 중간 산출물 build/icon.iconset/)

**왜 그림 파일이 아니라 코드인가:** 어디서 온지 모를 이미지를 저장소에 두지 않기 위해서다.
여기서 그리는 색은 앱 화면과 같은 값(`src/renderer/src/styles.css` 의 `--primary: #2e6f6a`)이고,
모양도 제품이 하는 일에서 나왔다. 색이나 모양을 바꾸려면 이 파일을 고치고 다시 돌린다.

**무엇을 그리는가:** 흰 보고서 한 장과 그 위의 물음표.
이 프로그램은 글을 대신 써 주지 않고 **질문으로 돕는다**(PRD 1절, `CLAUDE.md` §1).
그래서 연필이나 마법봉이 아니라 물음표다.

macOS 아이콘 격자를 따른다. 1024×1024 판에 824×824 둥근 사각형을 두고 가장자리를 비운다.
Pillow 와 macOS 의 `sips`·`iconutil` 만 쓴다. 내려받는 것은 없다.
"""

from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

BUILD = Path(__file__).resolve().parent

CANVAS = 1024
# macOS 격자: 824 정사각형을 가운데 두고 위아래로 100 씩 비운다.
TILE = 824
TILE_XY = (CANVAS - TILE) // 2
TILE_RADIUS = 185

# 앱 화면의 강조색(--primary)과 그보다 어두운 색. 위에서 아래로 옅게 흐른다.
TEAL_LIGHT = (58, 138, 130)
TEAL_DARK = (26, 74, 70)
PAPER = (255, 255, 255)
# 종이 위의 글줄. 본문 글자색을 옅게 쓴 것이다.
LINE = (196, 205, 204)

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    """물음표를 그릴 글꼴. 없으면 무엇이 없는지 알리고 멈춘다."""
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit(f"글꼴을 찾지 못했습니다. 확인한 곳:\n" + "\n".join(FONT_CANDIDATES))


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """위에서 아래로 색이 바뀌는 사각형."""
    strip = Image.new("RGB", (1, size))
    pixels = strip.load()
    for y in range(size):
        ratio = y / (size - 1)
        pixels[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
    return strip.resize((size, size))


def draw_icon() -> Image.Image:
    icon = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    # 1. 둥근 사각형 바탕. 그라디언트를 둥근 사각형 모양으로 오려 붙인다.
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (TILE_XY, TILE_XY, TILE_XY + TILE, TILE_XY + TILE), radius=TILE_RADIUS, fill=255
    )
    gradient = Image.new("RGB", (CANVAS, CANVAS))
    gradient.paste(vertical_gradient(CANVAS, TEAL_LIGHT, TEAL_DARK), (0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(icon)

    # 2. 보고서 한 장. 16px 로 줄여도 종이로 보이도록 너무 좁지 않게 잡는다.
    paper_w, paper_h = 440, 470
    paper_x = (CANVAS - paper_w) // 2
    paper_y = (CANVAS - paper_h) // 2 - 8
    draw.rounded_rectangle(
        (paper_x, paper_y, paper_x + paper_w, paper_y + paper_h), radius=36, fill=PAPER
    )

    # 3. 글줄 두 개. 사용자가 **먼저 쓴 글**이다 (선행 작성 보장).
    #    작은 크기에서 뭉개지지 않도록 줄 수를 줄이고 사이를 넓게 띄운다.
    line_x = paper_x + 62
    line_h = 30
    for index, width in enumerate((316, 218)):
        top = paper_y + 64 + index * 62
        draw.rounded_rectangle((line_x, top, line_x + width, top + line_h), radius=15, fill=LINE)

    # 4. 물음표. 크게 둔다. 16px 로 줄였을 때 남는 것은 이것뿐이다.
    font = load_font(268)
    # 글줄 아래 남은 자리의 한가운데. 글줄은 paper_y+156 에서 끝나고 종이는 paper_y+470 에서 끝난다.
    mark_center = (CANVAS // 2, paper_y + 318)
    draw.text(mark_center, "?", font=font, fill=TEAL_DARK, anchor="mm")

    return icon


def build_icns(source: Image.Image) -> Path:
    """iconset 폴더를 만들고 iconutil 로 .icns 로 묶는다."""
    iconset = BUILD / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for old in iconset.glob("*.png"):
        old.unlink()

    # macOS 가 요구하는 크기 전부. 16 부터 512@2x 까지.
    for size in (16, 32, 128, 256, 512):
        source.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        double = size * 2
        source.resize((double, double), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")

    icns = BUILD / "icon.icns"
    subprocess.run(["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    return icns


def main() -> int:
    icon = draw_icon()
    icon.save(BUILD / "icon.png")
    icns = build_icns(icon)
    print(f"아이콘을 만들었습니다: {icns}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
