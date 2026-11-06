"""教学模式：轮询鼠标/键盘边沿，缓冲用户操作事件（不注入输入）。

与 glance 同进程。敏感窗标题命中时给事件打 sensitive，正文由 Host 落本地、不上模型。
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Any

import ctypes
import ctypes.wintypes as w

user32 = ctypes.windll.user32

VK_LBUTTON = 0x01
VK_RBUTTON = 0x02
VK_MBUTTON = 0x04

# 与 policy / episode 对齐的轻量敏感标题
_SENSITIVE_TITLE_RE = None


def _sensitive_re():
    global _SENSITIVE_TITLE_RE
    if _SENSITIVE_TITLE_RE is None:
        import re
        _SENSITIVE_TITLE_RE = re.compile(
            r"1password|bitwarden|keepass|lastpass|密码本|密码|口令|credential|password|passwd|"
            r"bank|银行|支付|alipay|微信支付|paypal|uac|用户账户控制|windows\s*安全",
            re.I,
        )
    return _SENSITIVE_TITLE_RE


def _cursor() -> tuple[int, int]:
    pt = w.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def _window_title_at(x: int, y: int) -> str:
    pt = w.POINT(int(x), int(y))
    hwnd = user32.WindowFromPoint(pt)
    if not hwnd:
        return ""
    root = user32.GetAncestor(hwnd, 2)  # GA_ROOT
    if root:
        hwnd = root
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value or ""


def _foreground_title() -> str:
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return ""
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value or ""


def _key_down(vk: int) -> bool:
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


def _vk_to_text(vk: int, shift: bool) -> str | None:
    if 0x30 <= vk <= 0x39:  # 0-9
        return chr(vk)
    if 0x41 <= vk <= 0x5A:  # A-Z
        ch = chr(vk)
        return ch if shift else ch.lower()
    extra = {
        0x20: " ",
        0x09: "\t",
        0x0D: "\n",
        0x08: None,  # backspace 单独记
    }
    if vk in extra:
        return extra[vk]
    return None


class ObserveSession:
    def __init__(self) -> None:
        self._q: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._prev_mouse = {VK_LBUTTON: False, VK_RBUTTON: False, VK_MBUTTON: False}
        self._prev_keys: dict[int, bool] = {}
        self._type_buf = ""
        self._type_sensitive = False
        self._type_window = ""
        self._type_at = 0.0
        self._last_click_at = 0.0

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="glance-observe", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._flush_type()
        self._stop.set()
        t = self._thread
        if t:
            t.join(timeout=1.5)
        self._thread = None

    def drain(self, limit: int = 200) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        while len(out) < limit:
            try:
                out.append(self._q.get_nowait())
            except queue.Empty:
                break
        return out

    def _emit(self, ev: dict[str, Any]) -> None:
        ev.setdefault("at", time.time())
        try:
            self._q.put_nowait(ev)
        except queue.Full:
            pass

    def _flush_type(self) -> None:
        if not self._type_buf:
            return
        self._emit({
            "kind": "type",
            "text": self._type_buf,
            "window": {"title": self._type_window},
            "sensitive": bool(self._type_sensitive),
        })
        self._type_buf = ""
        self._type_sensitive = False
        self._type_window = ""
        self._type_at = 0.0

    def _is_sensitive(self, title: str) -> bool:
        t = title or ""
        return bool(t and _sensitive_re().search(t))

    def _loop(self) -> None:
        while not self._stop.wait(0.04):
            try:
                self._tick_mouse()
                self._tick_keys()
                if self._type_buf and (time.time() - self._type_at) > 0.55:
                    self._flush_type()
            except Exception:
                # 录制失败不能拖垮 sidecar
                pass

    def _tick_mouse(self) -> None:
        x, y = _cursor()
        title = _window_title_at(x, y) or _foreground_title()
        sensitive = self._is_sensitive(title)
        now = time.time()
        for vk, button in (
            (VK_LBUTTON, "left"),
            (VK_RBUTTON, "right"),
            (VK_MBUTTON, "middle"),
        ):
            down = _key_down(vk)
            was = self._prev_mouse[vk]
            self._prev_mouse[vk] = down
            if down and not was:
                self._flush_type()
                kind = "click"
                if button == "left" and (now - self._last_click_at) < 0.35:
                    kind = "double_click"
                self._last_click_at = now
                self._emit({
                    "kind": kind,
                    "button": button,
                    "x": x,
                    "y": y,
                    "window": {"title": title},
                    "sensitive": sensitive,
                })

    def _tick_keys(self) -> None:
        shift = _key_down(0x10)
        ctrl = _key_down(0x11)
        alt = _key_down(0x12)
        win = _key_down(0x5B)
        title = _foreground_title()
        sensitive = self._is_sensitive(title)

        # 组合键：ctrl/alt/win + 字母
        if ctrl or alt or win:
            for vk in list(range(0x41, 0x5B)) + list(range(0x30, 0x3A)) + [
                0x0D, 0x1B, 0x09, 0x2E, 0x08, 0x70, 0x71, 0x72, 0x73,
            ]:
                down = _key_down(vk)
                was = self._prev_keys.get(vk, False)
                self._prev_keys[vk] = down
                if not (down and not was):
                    continue
                self._flush_type()
                parts = []
                if ctrl:
                    parts.append("ctrl")
                if alt:
                    parts.append("alt")
                if win:
                    parts.append("win")
                if shift:
                    parts.append("shift")
                name = {
                    0x0D: "enter", 0x1B: "esc", 0x09: "tab", 0x2E: "delete", 0x08: "backspace",
                }.get(vk)
                if name is None and 0x70 <= vk <= 0x7B:
                    name = f"f{vk - 0x6F}"
                if name is None and 0x41 <= vk <= 0x5A:
                    name = chr(vk).lower()
                if name is None and 0x30 <= vk <= 0x39:
                    name = chr(vk)
                if not name:
                    continue
                parts.append(name)
                self._emit({
                    "kind": "key",
                    "keys": "+".join(parts),
                    "window": {"title": title},
                    "sensitive": sensitive,
                })
            return

        for vk in list(range(0x08, 0x93)):
            if vk in (0x10, 0x11, 0x12, 0x5B, 0x5C):  # modifiers
                continue
            if vk in (VK_LBUTTON, VK_RBUTTON, VK_MBUTTON):
                continue
            down = _key_down(vk)
            was = self._prev_keys.get(vk, False)
            self._prev_keys[vk] = down
            if not (down and not was):
                continue
            if vk == 0x08:  # backspace
                if self._type_buf:
                    self._type_buf = self._type_buf[:-1]
                    self._type_at = time.time()
                else:
                    self._emit({
                        "kind": "key",
                        "keys": "backspace",
                        "window": {"title": title},
                        "sensitive": sensitive,
                    })
                continue
            if vk == 0x0D:
                self._flush_type()
                self._emit({
                    "kind": "key",
                    "keys": "enter",
                    "window": {"title": title},
                    "sensitive": sensitive,
                })
                continue
            ch = _vk_to_text(vk, shift)
            if ch is None:
                continue
            if not self._type_buf:
                self._type_window = title
                self._type_sensitive = sensitive
            else:
                self._type_sensitive = self._type_sensitive or sensitive
            self._type_buf += ch
            self._type_at = time.time()


_SESSION = ObserveSession()


def handle_observe(req: dict) -> dict:
    action = str(req.get("action") or "poll").strip().lower()
    if action in ("start", "on"):
        _SESSION.start()
        return {"ok": True, "running": True, "events": []}
    if action in ("stop", "off"):
        events = _SESSION.drain()
        _SESSION.stop()
        return {"ok": True, "running": False, "events": events}
    if action in ("poll", "drain", "status"):
        if not _SESSION.running and action != "status":
            return {"ok": True, "running": False, "events": []}
        events = _SESSION.drain(int(req.get("limit") or 200))
        return {"ok": True, "running": _SESSION.running, "events": events}
    return {
        "ok": False,
        "error": {"code": "BAD_REQUEST", "message": f"未知 observe.action: {action}"},
    }
