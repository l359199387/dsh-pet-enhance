#!/usr/bin/env python3
"""64×36 网格 HSV 变化分（0–255）。

思路借鉴「按画面变化量筛帧」，实现自写（Pillow），不复用参考项目 JS。
每格 4 点采样降噪；色相按环形差，低饱和降权。
"""

from __future__ import annotations

from typing import Iterable

SCAN_W = 64
SCAN_H = 36
CELLS = SCAN_W * SCAN_H


def grid_rgb_from_image(image) -> list[float]:
    """把 PIL 图降成 SCAN_W×SCAN_H×3 的 RGB 均值网格（0–255 浮点）。"""
    rgb = image.convert("RGB")
    w, h = rgb.size
    if w <= 0 or h <= 0:
        return [0.0] * (CELLS * 3)
    px = rgb.load()
    sx = w / SCAN_W
    sy = h / SCAN_H
    out = [0.0] * (CELLS * 3)
    for gy in range(SCAN_H):
        y0 = int((gy + 0.25) * sy)
        y1 = int((gy + 0.75) * sy)
        y0 = min(max(y0, 0), h - 1)
        y1 = min(max(y1, 0), h - 1)
        for gx in range(SCAN_W):
            x0 = int((gx + 0.25) * sx)
            x1 = int((gx + 0.75) * sx)
            x0 = min(max(x0, 0), w - 1)
            x1 = min(max(x1, 0), w - 1)
            samples = (px[x0, y0], px[x1, y0], px[x0, y1], px[x1, y1])
            i = (gy * SCAN_W + gx) * 3
            out[i] = (samples[0][0] + samples[1][0] + samples[2][0] + samples[3][0]) * 0.25
            out[i + 1] = (samples[0][1] + samples[1][1] + samples[2][1] + samples[3][1]) * 0.25
            out[i + 2] = (samples[0][2] + samples[1][2] + samples[2][2] + samples[3][2]) * 0.25
    return out


def rgb_to_hsv(rgb: list[float]) -> list[float]:
    """RGB → HSV，各通道缩放到 0–255（H 由角度线性映射）。"""
    out = [0.0] * len(rgb)
    for i in range(0, len(rgb), 3):
        rn = rgb[i] / 255.0
        gn = rgb[i + 1] / 255.0
        bn = rgb[i + 2] / 255.0
        mx = rn if rn > gn else gn
        mx = mx if mx > bn else bn
        mn = rn if rn < gn else gn
        mn = mn if mn < bn else bn
        d = mx - mn
        h = 0.0
        if d != 0.0:
            if mx == rn:
                h = ((gn - bn) / d) % 6.0
            elif mx == gn:
                h = (bn - rn) / d + 2.0
            else:
                h = (rn - gn) / d + 4.0
            h *= 60.0
            if h < 0:
                h += 360.0
        out[i] = (h / 360.0) * 255.0
        out[i + 1] = 0.0 if mx == 0.0 else (d / mx) * 255.0
        out[i + 2] = mx * 255.0
    return out


def score_pair(prev: list[float], cur: list[float]) -> float:
    """两帧 HSV 加权绝对差均值，刻度 0–255。"""
    if not prev or not cur or len(prev) != len(cur):
        return 0.0
    n = len(cur) // 3
    if n <= 0:
        return 0.0
    total = 0.0
    for i in range(0, len(cur), 3):
        dh = abs(cur[i] - prev[i])
        hue = dh if dh <= 255.0 - dh else 255.0 - dh
        weight = (cur[i + 1] if cur[i + 1] < prev[i + 1] else prev[i + 1]) / 255.0
        total += hue * weight + abs(cur[i + 1] - prev[i + 1]) + abs(cur[i + 2] - prev[i + 2])
    return total / (n * 3.0)


def hsv_from_image(image) -> list[float]:
    return rgb_to_hsv(grid_rgb_from_image(image))


def score_images(a, b) -> float:
    return score_pair(hsv_from_image(a), hsv_from_image(b))


class FrameScorer:
    """流式打分：记住上一帧 HSV。首帧 score 为 None。"""

    def __init__(self) -> None:
        self._prev: list[float] | None = None

    def reset(self) -> None:
        self._prev = None

    def push_image(self, image) -> float | None:
        cur = hsv_from_image(image)
        if self._prev is None:
            self._prev = cur
            return None
        score = score_pair(self._prev, cur)
        self._prev = cur
        return score

    def push_hsv(self, hsv: Iterable[float]) -> float | None:
        cur = list(hsv)
        if self._prev is None:
            self._prev = cur
            return None
        score = score_pair(self._prev, cur)
        self._prev = cur
        return score
