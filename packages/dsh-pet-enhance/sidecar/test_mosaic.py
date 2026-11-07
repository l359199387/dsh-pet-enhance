#!/usr/bin/env python3
"""拼图画布对齐、布局与 cover 消黑边单测。"""

from __future__ import annotations

import unittest

from PIL import Image

import mosaic


class MosaicTests(unittest.TestCase):
    def test_canvas_aligned_to_42(self):
        for q, (w, h) in mosaic.CANVAS.items():
            self.assertEqual(w % 42, 0, q)
            self.assertEqual(h % 42, 0, q)

    def test_layout_landscape(self):
        # 横屏：2 帧并排；3–4 强制 2×2
        self.assertEqual(mosaic.layout_for_count(1, 16 / 9), (1, 1))
        self.assertEqual(mosaic.layout_for_count(2, 16 / 9), (2, 1))
        self.assertEqual(mosaic.layout_for_count(3, 16 / 9), (2, 2))
        self.assertEqual(mosaic.layout_for_count(4, 16 / 9), (2, 2))

    def test_layout_portrait(self):
        # 竖屏 9:16：2 帧并排
        self.assertEqual(mosaic.layout_for_count(2, 9 / 16), (2, 1))
        self.assertEqual(mosaic.layout_for_count(4, 9 / 16), (2, 2))

    def test_compose_four_aligned(self):
        frames = [{"image": Image.new("RGB", (160, 90), (i * 40, 20, 20))} for i in range(4)]
        img, meta = mosaic.compose_mosaic(frames, quality="low")
        self.assertEqual(meta["cols"], 2)
        self.assertEqual(meta["rows"], 2)
        self.assertEqual(meta["w"] % 42, 0)
        self.assertEqual(meta["h"] % 42, 0)
        self.assertEqual(img.size, (meta["w"], meta["h"]))

    def test_compose_two_landscape_no_letterbox(self):
        """横屏 2 帧：2×1 并排；格内 cover 填满。"""
        red = (220, 40, 40)
        frames = [{"image": Image.new("RGB", (320, 180), red)} for _ in range(2)]
        img, meta = mosaic.compose_mosaic(frames, quality="low")
        self.assertEqual(meta["cols"], 2)
        self.assertEqual(meta["rows"], 1)
        self.assertEqual(meta["w"] % 42, 0)
        self.assertEqual(meta["h"] % 42, 0)

        strip = meta["strip"]
        body_h = meta["h"] - strip
        cell_w = meta["w"] // meta["cols"]
        cell_h = body_h // meta["rows"]
        samples = [
            (2, 16),
            (cell_w - 3, 16),
            (2, cell_h - 3),
            (cell_w - 3, cell_h - 3),
            (cell_w + 2, 16),
            (cell_w + cell_w - 3, cell_h - 3),
        ]
        pad = (24, 24, 28)
        bg = (18, 18, 22)
        for x, y in samples:
            px = img.getpixel((x, y))
            self.assertNotEqual(px, pad, f"letterbox at {(x, y)}")
            self.assertNotEqual(px, bg, f"empty cell at {(x, y)}")
            self.assertGreater(px[0], 180, f"not filled red at {(x, y)}: {px}")

    def test_cover_fills_box(self):
        src = Image.new("RGB", (200, 100), (10, 200, 10))
        out = mosaic._cover(src, 80, 80)
        self.assertEqual(out.size, (80, 80))
        # 中心与边都应是绿（无灰边）
        for pt in [(0, 0), (79, 0), (0, 79), (79, 79), (40, 40)]:
            self.assertEqual(out.getpixel(pt), (10, 200, 10), pt)

    def test_stack_vertical(self):
        a = Image.new("RGB", (100, 40), (10, 0, 0))
        b = Image.new("RGB", (80, 30), (0, 10, 0))
        out = mosaic.stack_vertical([a, b], gap=4)
        self.assertEqual(out.size, (100, 40 + 4 + 30))


if __name__ == "__main__":
    unittest.main()
