#!/usr/bin/env python3
"""多帧拼图：对齐 see-now region —— 1 / 2×1 / 2×2（最多 4 格），画布对齐 42px。
超过 4 帧由上层拆成多张拼图。"""

from __future__ import annotations

from io import BytesIO

# 与 docs/03 §7、capture.CANVAS_WIDTH 对齐
CANVAS = {
    "low": (798, 462),
    "standard": (1050, 630),
    "high": (1260, 756),
}
STRIP = {"low": 12, "standard": 30, "high": 36}
CELL = 42
MAX_FRAMES = 4


def normalize_quality(value: str | None) -> str:
    q = str(value or "").strip().lower()
    return q if q in CANVAS else "low"


def canvas_size(quality: str | None) -> tuple[int, int]:
    return CANVAS[normalize_quality(quality)]


def layout_for_count(n: int) -> tuple[int, int]:
    """返回 (cols, rows)。对齐 see-now：1→1×1；2→2×1；3–4→2×2。"""
    count = max(1, min(MAX_FRAMES, int(n)))
    if count <= 1:
        return 1, 1
    if count == 2:
        return 2, 1
    return 2, 2


def _pil_resample():
    from PIL import Image
    return getattr(Image, "Resampling", Image).LANCZOS


def _fit(image, box_w: int, box_h: int):
    from PIL import Image

    img = image.convert("RGB")
    if img.width <= 0 or img.height <= 0 or box_w <= 0 or box_h <= 0:
        return Image.new("RGB", (max(1, box_w), max(1, box_h)), (24, 24, 28))
    scale = min(box_w / img.width, box_h / img.height)
    nw = max(1, int(round(img.width * scale)))
    nh = max(1, int(round(img.height * scale)))
    resized = img.resize((nw, nh), resample=_pil_resample())
    canvas = Image.new("RGB", (box_w, box_h), (24, 24, 28))
    ox = (box_w - nw) // 2
    oy = (box_h - nh) // 2
    canvas.paste(resized, (ox, oy))
    return canvas


def compose_mosaic(
    frames: list[dict],
    *,
    quality: str = "low",
    labels: list[str] | None = None,
):
    """
    frames: [{image: PIL.Image, ...}, ...] 最多 4 张 → 按 layout_for_count。
    返回 (PIL.Image, meta dict)。
    """
    from PIL import Image, ImageDraw, ImageFont

    q = normalize_quality(quality)
    W, H = canvas_size(q)
    assert W % CELL == 0 and H % CELL == 0, "画布必须对齐 42"

    n = max(1, min(MAX_FRAMES, len(frames) or 1))
    cols, rows = layout_for_count(n)
    strip = STRIP[q]
    body_h = H - strip
    cell_w = W // cols
    cell_h = body_h // rows

    out = Image.new("RGB", (W, H), (18, 18, 22))
    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None

    for i in range(n):
        col = i % cols
        row = i // cols
        x0 = col * cell_w
        y0 = row * cell_h
        img = frames[i].get("image") if isinstance(frames[i], dict) else frames[i]
        cell = _fit(img, cell_w - 2, cell_h - 2)
        out.paste(cell, (x0 + 1, y0 + 1))
        label = None
        if labels and i < len(labels):
            label = labels[i]
        elif isinstance(frames[i], dict):
            label = frames[i].get("label")
        if not label:
            label = str(i + 1)
        draw.rectangle([x0, y0, x0 + cell_w - 1, y0 + 14], fill=(0, 0, 0))
        draw.text((x0 + 3, y0 + 1), str(label)[:48], fill=(220, 220, 230), font=font)

    draw.rectangle([0, body_h, W, H], fill=(12, 12, 16))
    summary = f"{n} frames · {cols}×{rows} · {q} {W}×{H}"
    draw.text((6, body_h + max(0, (strip - 10) // 2)), summary, fill=(160, 160, 170), font=font)

    return out, {
        "w": W,
        "h": H,
        "quality": q,
        "cols": cols,
        "rows": rows,
        "frames": n,
        "strip": strip,
    }


def stack_vertical(images: list, *, gap: int = 8):
    """把多张已合成的拼图自上而下叠成一张（每张仍是完整 2×2 清晰度）。"""
    from PIL import Image

    if not images:
        raise ValueError("stack 需要至少 1 张图")
    rgb = [im.convert("RGB") for im in images]
    width = max(im.width for im in rgb)
    height = sum(im.height for im in rgb) + gap * (len(rgb) - 1)
    out = Image.new("RGB", (width, height), (18, 18, 22))
    y = 0
    for i, im in enumerate(rgb):
        x = (width - im.width) // 2
        out.paste(im, (x, y))
        y += im.height
        if i < len(rgb) - 1:
            y += gap
    return out


def encode_png(image) -> bytes:
    buf = BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
