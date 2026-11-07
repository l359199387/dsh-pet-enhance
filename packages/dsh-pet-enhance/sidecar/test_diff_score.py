#!/usr/bin/env python3
"""变化分纯函数单测（不启 sidecar 进程）。"""

from __future__ import annotations

import unittest

from PIL import Image

import diff_score as ds


def solid(w: int, h: int, rgb: tuple[int, int, int]) -> Image.Image:
    return Image.new("RGB", (w, h), rgb)


class DiffScoreTests(unittest.TestCase):
    def test_identical_is_zero(self):
        a = solid(320, 180, (40, 80, 120))
        self.assertAlmostEqual(ds.score_images(a, a), 0.0, places=5)

    def test_hue_shift_is_large(self):
        red = solid(320, 180, (220, 30, 30))
        blue = solid(320, 180, (30, 30, 220))
        score = ds.score_images(red, blue)
        self.assertGreater(score, 20.0)

    def test_scorer_first_none(self):
        scorer = ds.FrameScorer()
        self.assertIsNone(scorer.push_image(solid(64, 36, (10, 10, 10))))
        s = scorer.push_image(solid(64, 36, (200, 200, 200)))
        self.assertIsInstance(s, float)
        self.assertGreater(s, 5.0)

    def test_grid_size(self):
        g = ds.grid_rgb_from_image(solid(800, 450, (1, 2, 3)))
        self.assertEqual(len(g), ds.CELLS * 3)


if __name__ == "__main__":
    unittest.main()
