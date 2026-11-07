#!/usr/bin/env python3
"""拼图画布对齐与布局单测。"""

from __future__ import annotations

import unittest

from PIL import Image

import mosaic


class MosaicTests(unittest.TestCase):
    def test_canvas_aligned_to_42(self):
        for q, (w, h) in mosaic.CANVAS.items():
            self.assertEqual(w % 42, 0, q)
            self.assertEqual(h % 42, 0, q)

    def test_layout(self):
        self.assertEqual(mosaic.layout_for_count(1), (1, 1))
        self.assertEqual(mosaic.layout_for_count(4), (2, 2))
        self.assertEqual(mosaic.layout_for_count(8), (4, 2))
        self.assertEqual(mosaic.layout_for_count(10), (4, 3))
        self.assertEqual(mosaic.layout_for_count(12), (4, 3))

    def test_compose_four(self):
        frames = [{"image": Image.new("RGB", (100, 60), (i * 40, 20, 20))} for i in range(4)]
        img, meta = mosaic.compose_mosaic(frames, quality="low")
        self.assertEqual(meta["w"], 798)
        self.assertEqual(meta["h"], 462)
        self.assertEqual(meta["cols"], 2)
        self.assertEqual(meta["rows"], 2)
        self.assertEqual(img.size, (798, 462))


if __name__ == "__main__":
    unittest.main()
