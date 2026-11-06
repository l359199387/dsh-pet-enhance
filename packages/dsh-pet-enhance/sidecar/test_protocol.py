#!/usr/bin/env python3
"""sidecar 协议单测：真起 glance.py 走 JSON Lines；不许动鼠标。"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GLANCE = HERE / "glance.py"


def _python() -> str:
    return os.environ.get("DSH_PYTHON") or sys.executable


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.proc = subprocess.Popen(
            [_python(), str(GLANCE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._id = 0

    def tearDown(self):
        if self.proc.poll() is None:
            try:
                self._ask("quit", timeout=2)
            except Exception:
                pass
            try:
                self.proc.kill()
            except Exception:
                pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                if stream:
                    stream.close()
            except Exception:
                pass

    def _ask(self, op: str, timeout: float = 15, **fields):
        self._id += 1
        req = {"id": self._id, "op": op, **fields}
        assert self.proc.stdin is not None
        assert self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                stderr = self.proc.stderr.read() if self.proc.stderr else ""
                raise AssertionError(f"sidecar 提前退出：{stderr}")
            resp = json.loads(line)
            if resp.get("id") == self._id:
                return resp
        raise TimeoutError(f"等 {op} 超时")

    def test_hello_and_quit(self):
        hello = self._ask("hello")
        self.assertTrue(hello.get("ok"), hello)
        self.assertEqual(hello.get("engine"), "pillow")
        self.assertTrue(hello.get("input"))
        self.assertIn("screen", hello)
        self.assertGreater(hello["screen"]["w"], 0)
        self.assertGreater(hello["screen"]["h"], 0)

        bye = self._ask("quit")
        self.assertTrue(bye.get("ok"))
        self.assertTrue(bye.get("bye"))

    def test_windows_list(self):
        self._ask("hello")
        resp = self._ask("windows")
        self.assertTrue(resp.get("ok"), resp)
        self.assertIsInstance(resp.get("windows"), list)
        # 本机至少有一个有标题的可见窗（任务栏/桌面宿主）
        self.assertGreaterEqual(len(resp["windows"]), 1)
        first = resp["windows"][0]
        self.assertIn("title", first)
        self.assertIn("hwnd", first)
        self.assertIn("rect", first)

    def test_capture_screen_png(self):
        self._ask("hello")
        resp = self._ask("capture", source={"kind": "screen"}, max_width=798)
        self.assertTrue(resp.get("ok"), resp)
        raw = base64.b64decode(resp["png"])
        self.assertEqual(raw[:8], b"\x89PNG\r\n\x1a\n")
        self.assertLessEqual(resp["w"], 798)
        self.assertGreater(resp["h"], 0)
        self.assertIn("cursor", resp)
        self.assertIn("active", resp)

    def test_capture_missing_window_gives_candidates(self):
        self._ask("hello")
        resp = self._ask(
            "capture",
            source={"kind": "window", "match": "___no_such_window_zzzz___"},
        )
        self.assertFalse(resp.get("ok"))
        err = resp.get("error") or {}
        self.assertEqual(err.get("code"), "WINDOW_NOT_FOUND")
        self.assertIsInstance(err.get("candidates"), list)
        self.assertGreaterEqual(len(err["candidates"]), 1)
        self.assertLessEqual(len(err["candidates"]), 3)

    def test_input_dry_run_move(self):
        """不许真的动鼠标：dryRun 只校验协议。"""
        self._ask("hello")
        resp = self._ask(
            "input",
            actions=[{"kind": "move", "x": 100, "y": 100, "duration": 0}],
            dryRun=True,
        )
        self.assertTrue(resp.get("ok"), resp)
        self.assertTrue(resp.get("dryRun"))
        self.assertEqual(resp["done"][0]["kind"], "move")

    def test_input_dry_run_type_and_key(self):
        self._ask("hello")
        typed = self._ask(
            "input",
            actions=[{"kind": "type", "text": "你好hello"}],
            dryRun=True,
        )
        self.assertTrue(typed.get("ok"), typed)
        keyed = self._ask(
            "input",
            actions=[{"kind": "key", "keys": "ctrl+s"}],
            dryRun=True,
        )
        self.assertTrue(keyed.get("ok"), keyed)

    def test_score_title_helper(self):
        # 纯函数，不需要进程；确认中文/大小写匹配方向对。
        sys.path.insert(0, str(HERE))
        import glance as g

        self.assertGreater(g.score_title("edge", "Microsoft Edge"), 0.8)
        self.assertGreater(g.score_title("记事本", "无标题 - 记事本"), 0.8)
        self.assertLess(g.score_title("zzz", "Microsoft Edge"), 0.45)


class BlackDetectTests(unittest.TestCase):
    def test_near_black(self):
        sys.path.insert(0, str(HERE))
        from PIL import Image
        import glance as g

        black = Image.new("RGB", (200, 100), (0, 0, 0))
        self.assertTrue(g._is_near_black(black))
        colorful = Image.new("RGB", (200, 100), (40, 120, 200))
        self.assertFalse(g._is_near_black(colorful))


if __name__ == "__main__":
    unittest.main()
