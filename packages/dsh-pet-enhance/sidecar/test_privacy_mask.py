#!/usr/bin/env python3
"""隐私遮罩单测。"""

from __future__ import annotations

import unittest

from PIL import Image

import privacy_mask as pm


class PrivacyMaskTests(unittest.TestCase):
    def test_title_match(self):
        pats = pm.compile_patterns()
        self.assertTrue(pm.title_matches("1Password — Login", pats))
        self.assertTrue(pm.title_matches("我的密码本.xlsx", pats))
        self.assertFalse(pm.title_matches("记事本", pats))

    def test_mask_paints_black(self):
        img = Image.new("RGB", (200, 100), (255, 0, 0))
        # capture 覆盖全图；敏感窗盖左半
        windows = [{"title": "Bitwarden", "rect": [0, 0, 100, 100]}]
        out, titles = pm.apply_mask(
            img,
            capture_rect=(0, 0, 200, 100),
            windows=windows,
            patterns=pm.compile_patterns(),
        )
        self.assertTrue(titles)
        # 左上应被涂黑
        self.assertEqual(out.getpixel((10, 10)), (0, 0, 0))
        # 右半仍红
        self.assertEqual(out.getpixel((150, 50)), (255, 0, 0))


if __name__ == "__main__":
    unittest.main()
