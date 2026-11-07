#!/usr/bin/env python3
"""按窗口标题把敏感区域涂黑（缩略图与模型图同一套规则）。"""

from __future__ import annotations

import re
from typing import Iterable

# 与 Host policy.DENY_TITLE_RES 口径对齐（可读不可点 → 看图也遮）
DEFAULT_TITLE_PATTERNS = (
    r"1password|bitwarden|keepass|lastpass|密码本|密码|口令|credential|password|passwd",
    r"bank|银行|支付|alipay|微信支付|paypal",
    r"uac|用户账户控制|windows\s*安全|consent\.exe",
)


def compile_patterns(extra: Iterable[str] | None = None) -> list[re.Pattern[str]]:
    patterns: list[re.Pattern[str]] = []
    for raw in DEFAULT_TITLE_PATTERNS:
        patterns.append(re.compile(raw, re.I))
    if extra:
        for raw in extra:
            s = str(raw or "").strip()
            if not s:
                continue
            try:
                patterns.append(re.compile(s, re.I))
            except re.error:
                patterns.append(re.compile(re.escape(s), re.I))
    return patterns


def title_matches(title: str, patterns: list[re.Pattern[str]]) -> bool:
    t = str(title or "").strip()
    if not t:
        return False
    return any(p.search(t) for p in patterns)


def _intersect(
    a: tuple[int, int, int, int],
    b: tuple[int, int, int, int],
) -> tuple[int, int, int, int] | None:
    left = max(a[0], b[0])
    top = max(a[1], b[1])
    right = min(a[2], b[2])
    bottom = min(a[3], b[3])
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def apply_mask(
    image,
    *,
    capture_rect: tuple[int, int, int, int],
    windows: list[dict],
    patterns: list[re.Pattern[str]] | None = None,
) -> tuple[object, list[str]]:
    """
    在 image 上把命中标题的窗口矩形涂黑。
    capture_rect: 原图像素对应的屏幕 (left, top, right, bottom)。
    返回 (image, masked_titles)。
    """
    from PIL import ImageDraw

    pats = patterns if patterns is not None else compile_patterns()
    if image is None:
        return image, []

    iw, ih = image.size
    cl, ct, cr, cb = capture_rect
    cw = max(1, cr - cl)
    ch = max(1, cb - ct)
    sx = iw / float(cw)
    sy = ih / float(ch)

    draw = ImageDraw.Draw(image)
    masked: list[str] = []
    for win in windows or []:
        title = str(win.get("title") or "")
        if not title_matches(title, pats):
            continue
        rect = win.get("rect")
        if not (isinstance(rect, (list, tuple)) and len(rect) == 4):
            continue
        try:
            wl, wt, wr, wb = (int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3]))
        except (TypeError, ValueError):
            continue
        hit = _intersect((cl, ct, cr, cb), (wl, wt, wr, wb))
        if not hit:
            continue
        xl, yt, xr, yb = hit
        x0 = max(0, int(round((xl - cl) * sx)))
        y0 = max(0, int(round((yt - ct) * sy)))
        x1 = min(iw, int(round((xr - cl) * sx)))
        y1 = min(ih, int(round((yb - ct) * sy)))
        if x1 <= x0 or y1 <= y0:
            continue
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=(0, 0, 0))
        if title not in masked:
            masked.append(title[:80])
    return image, masked
