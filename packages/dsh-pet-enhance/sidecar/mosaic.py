#!/usr/bin/env python3
"""多帧拼图：对齐 see-now —— 最多 4 格；cover 填格消黑边；按源比例选布局并自适应画布。
超过 4 帧由上层拆成多张拼图。"""

from __future__ import annotations

import math
from io import BytesIO

# 与 docs/03 §7、capture.CANVAS_WIDTH 对齐（单帧参考画布 / token 预算锚点）
CANVAS = {
    "low": (798, 462),
    "standard": (1050, 630),
    "high": (1260, 756),
}
STRIP = {"low": 12, "standard": 30, "high": 36}
CELL = 42
MAX_FRAMES = 4
DEFAULT_ASPECT = 16 / 9


def normalize_quality(value: str | None) -> str:
    q = str(value or "").strip().lower()
    return q if q in CANVAS else "low"


def canvas_size(quality: str | None) -> tuple[int, int]:
    return CANVAS[normalize_quality(quality)]


def align_down(px: int, step: int = CELL) -> int:
    n = max(0, int(px))
    return max(step, (n // step) * step)


def frame_aspect(frames: list) -> float:
    """取首帧宽高比；无效则默认 16:9。"""
    for item in frames or []:
        img = item.get("image") if isinstance(item, dict) else item
        if img is None:
            continue
        w = getattr(img, "width", 0) or 0
        h = getattr(img, "height", 0) or 0
        if w > 0 and h > 0:
            return w / h
    return DEFAULT_ASPECT


def grid_plan(n: int, aspect_cell: float) -> tuple[int, int]:
    """
    n 帧、单格宽高比 → 选整图最接近 1:1 的 (cols, rows)。
    移植自 see-now layout.gridPlan（含空格惩罚、同向优先）。
    """
    count = max(1, min(MAX_FRAMES, int(n)))
    aspect = float(aspect_cell) if aspect_cell and aspect_cell > 0 else 1.0
    squarish = abs(aspect - 1.0) < 1e-9

    def score_of(cols: int, rows: int) -> tuple:
        width = cols * aspect
        ratio = width / rows
        holes = cols * rows - count
        score = abs(math.log(ratio)) + (holes / count)
        same_dir = (ratio >= 1) == (aspect >= 1)
        return (score, 0 if (squarish or same_dir) else 1, -cols)

    best = None
    best_key = None
    for cols in range(1, count + 1):
        rows = math.ceil(count / cols)
        key = score_of(cols, rows)
        if best is None or key < best_key:
            best = (cols, rows)
            best_key = key
    return best or (1, 1)


def layout_for_count(n: int, aspect: float = DEFAULT_ASPECT) -> tuple[int, int]:
    """
    返回 (cols, rows)。
    桌面横屏优先 2×2：3–4 帧强制 2×2；2 帧用 2×1 并排（避免 1×2 竖条）。
    竖屏仍走 gridPlan（2 帧并排 2×1）。
    """
    count = max(1, min(MAX_FRAMES, int(n)))
    aspect = float(aspect) if aspect and aspect > 0 else DEFAULT_ASPECT
    if count <= 1:
        return 1, 1
    if count >= 3:
        return 2, 2
    # count == 2
    if aspect >= 1:
        return 2, 1
    return grid_plan(count, aspect)


def sheet_size(
    quality: str | None,
    cols: int,
    rows: int,
    aspect_cell: float,
) -> tuple[int, int, int]:
    """
    按源格比例算画布：面积贴近档位画布（控 token），宽高对齐 42。
    返回 (W, H, strip)。
    """
    q = normalize_quality(quality)
    base_w, base_h = canvas_size(q)
    strip = STRIP[q]
    cols = max(1, int(cols))
    rows = max(1, int(rows))
    aspect = float(aspect_cell) if aspect_cell and aspect_cell > 0 else DEFAULT_ASPECT
    body_aspect = (cols * aspect) / rows  # body 宽/高

    target_area = float(base_w * base_h)
    # body_w * body_h ≈ target；body_w = body_aspect * body_h
    h_body = math.sqrt(target_area / body_aspect)
    w = body_aspect * h_body

    W = align_down(int(round(w)))
    # 保证可被列数整除（等宽格）
    while W >= CELL * cols and (W // cols) * cols != W:
        W -= CELL
    if W < CELL * cols:
        W = CELL * cols

    H = align_down(int(round(h_body + strip)))
    body_h = H - strip
    while body_h >= CELL * rows and (body_h // rows) * rows != body_h:
        H -= CELL
        body_h = H - strip
    if body_h < CELL * rows:
        body_h = CELL * rows
        H = align_down(body_h + strip)
        # 对齐后 strip 可能变；以 H - body 为实际 strip 不强制，compose 用 STRIP[q]
        if H - strip < body_h:
            H = body_h + strip
            if H % CELL != 0:
                H += CELL - (H % CELL)

    return W, H, strip


def _pil_resample():
    from PIL import Image
    return getattr(Image, "Resampling", Image).LANCZOS


def _cover(image, box_w: int, box_h: int):
    """覆盖式填格：短边铺满、长边居中裁掉，不留黑边（对齐 see-now cover）。"""
    from PIL import Image

    img = image.convert("RGB")
    bw = max(1, int(box_w))
    bh = max(1, int(box_h))
    if img.width <= 0 or img.height <= 0:
        return Image.new("RGB", (bw, bh), (24, 24, 28))

    scale = max(bw / img.width, bh / img.height)
    nw = max(1, int(round(img.width * scale)))
    nh = max(1, int(round(img.height * scale)))
    resized = img.resize((nw, nh), resample=_pil_resample())
    ox = max(0, (nw - bw) // 2)
    oy = max(0, (nh - bh) // 2)
    return resized.crop((ox, oy, ox + bw, oy + bh))


def compose_mosaic(
    frames: list[dict],
    *,
    quality: str = "low",
    labels: list[str] | None = None,
):
    """
    frames: [{image: PIL.Image, ...}, ...] 最多 4 张。
    返回 (PIL.Image, meta dict)。
    """
    from PIL import Image, ImageDraw, ImageFont

    q = normalize_quality(quality)
    n = max(1, min(MAX_FRAMES, len(frames) or 1))
    aspect = frame_aspect(frames)
    cols, rows = layout_for_count(n, aspect)
    W, H, strip = sheet_size(q, cols, rows, aspect)
    assert W % CELL == 0 and H % CELL == 0, "画布必须对齐 42"

    body_h = max(1, H - strip)
    cell_w = max(1, W // cols)
    cell_h = max(1, body_h // rows)

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
        # 1px 缝用背景色，格内 cover 填满
        inner_w = max(1, cell_w - 2)
        inner_h = max(1, cell_h - 2)
        cell = _cover(img, inner_w, inner_h)
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
        "aspect": round(aspect, 4),
    }


def stack_vertical(images: list, *, gap: int = 8):
    """把多张已合成的拼图自上而下叠成一张。"""
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
