"""Render the storefront icon at the sizes the plugin ships.

Source: assets/icon-256.png — the Everything application icon, MIT-licensed
(Copyright (c) 2022 voidtools). See assets/ICON-LICENSE.txt.

Outputs square, transparent PNGs. The awesome-dsh-plugin storefront draws the
tile at ~96px, so 180 is the smallest size worth carrying; 512 is kept for
anything that wants a sharper source.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "icon-256.png"
SIZES = (180, 256, 512)


def main() -> None:
    source = Image.open(SRC).convert("RGBA")
    if source.width != source.height:
        raise SystemExit(f"source icon is not square: {source.size}")

    for size in SIZES:
        out = ROOT / "assets" / f"icon-{size}.png"
        if size == source.width:
            # Keep the original bytes instead of re-encoding them.
            if out != SRC:
                out.write_bytes(SRC.read_bytes())
        else:
            source.resize((size, size), Image.LANCZOS).save(out, "PNG", optimize=True)
        print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
