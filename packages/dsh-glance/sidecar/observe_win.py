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
VK_XBUTTON1 = 0x05  # 侧键后退
VK_XBUTTON2 = 0x06  # 侧键前进

WH_MOUSE_LL = 14  # WH_MOUSE_LL（13 是键盘低级钩）
WM_MOUSEWHEEL = 0x020A
WM_MOUSEHWHEEL = 0x020E
WHEEL_DELTA = 120
# 滑轮静止超过此时长 → 一次滚动手势结束（不按每格截图）
SCROLL_IDLE_SEC = 0.45

# 与 policy / episode 对齐的轻量敏感标题
_SENSITIVE_TITLE_RE = None


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class _MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", _POINT),
        ("mouseData", w.DWORD),
        ("flags", w.DWORD),
        ("time", w.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


LowLevelMouseProc = ctypes.WINFUNCTYPE(
    ctypes.c_long,
    ctypes.c_int,
    w.WPARAM,
    w.LPARAM,
)


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
        self._prev_mouse = {
            VK_LBUTTON: False,
            VK_RBUTTON: False,
            VK_MBUTTON: False,
            VK_XBUTTON1: False,
            VK_XBUTTON2: False,
        }
        self._prev_keys: dict[int, bool] = {}
        self._type_buf = ""
        self._type_sensitive = False
        self._type_window = ""
        self._type_at = 0.0
        self._last_click_at = 0.0
        # 滑轮手势：开始发 scroll_start，静止后发 scroll_end（中间格数只累加）
        self._scroll_active = False
        self._scroll_delta = 0
        self._scroll_last_at = 0.0
        self._scroll_x = 0
        self._scroll_y = 0
        self._scroll_window = ""
        self._scroll_sensitive = False
        self._scroll_horizontal = False
        self._hook = None
        self._hook_proc = None

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
        self._flush_scroll_end()
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
        self._install_wheel_hook()
        try:
            while not self._stop.is_set():
                try:
                    self._pump_messages()
                    self._tick_mouse()
                    self._tick_keys()
                    self._tick_scroll_idle()
                    if self._type_buf and (time.time() - self._type_at) > 0.55:
                        self._flush_type()
                except Exception:
                    # 录制失败不能拖垮 sidecar
                    pass
                self._stop.wait(0.02)
        finally:
            self._uninstall_wheel_hook()

    def _pump_messages(self) -> None:
        msg = w.MSG()
        while user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):  # PM_REMOVE
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def _install_wheel_hook(self) -> None:
        if self._hook:
            return

        def _proc(n_code: int, wparam: int, lparam: int) -> int:
            try:
                if n_code >= 0 and wparam in (WM_MOUSEWHEEL, WM_MOUSEHWHEEL):
                    info = ctypes.cast(lparam, ctypes.POINTER(_MSLLHOOKSTRUCT)).contents
                    raw = ctypes.c_short(info.mouseData >> 16).value
                    steps = int(raw / WHEEL_DELTA) if WHEEL_DELTA else 0
                    if steps == 0 and raw != 0:
                        steps = 1 if raw > 0 else -1
                    self._on_wheel(
                        int(info.pt.x),
                        int(info.pt.y),
                        steps,
                        horizontal=(wparam == WM_MOUSEHWHEEL),
                    )
            except Exception:
                pass
            return int(user32.CallNextHookEx(self._hook, n_code, wparam, lparam))

        self._hook_proc = LowLevelMouseProc(_proc)
        self._hook = user32.SetWindowsHookExW(
            WH_MOUSE_LL,
            self._hook_proc,
            None,
            0,
        )

    def _uninstall_wheel_hook(self) -> None:
        if self._hook:
            try:
                user32.UnhookWindowsHookEx(self._hook)
            except Exception:
                pass
        self._hook = None
        self._hook_proc = None

    def _on_wheel(self, x: int, y: int, steps: int, horizontal: bool = False) -> None:
        if steps == 0:
            return
        self._flush_type()
        title = _window_title_at(x, y) or _foreground_title()
        sensitive = self._is_sensitive(title)
        now = time.time()
        if not self._scroll_active:
            self._scroll_active = True
            self._scroll_delta = 0
            self._scroll_horizontal = horizontal
            self._emit({
                "kind": "scroll_start",
                "x": x,
                "y": y,
                "delta": steps,
                "horizontal": bool(horizontal),
                "window": {"title": title},
                "sensitive": sensitive,
            })
        self._scroll_delta += steps
        self._scroll_last_at = now
        self._scroll_x = x
        self._scroll_y = y
        self._scroll_window = title
        self._scroll_sensitive = sensitive
        self._scroll_horizontal = horizontal

    def _tick_scroll_idle(self) -> None:
        if not self._scroll_active:
            return
        if (time.time() - self._scroll_last_at) < SCROLL_IDLE_SEC:
            return
        self._flush_scroll_end()

    def _flush_scroll_end(self) -> None:
        if not self._scroll_active:
            return
        self._emit({
            "kind": "scroll_end",
            "x": self._scroll_x,
            "y": self._scroll_y,
            "delta": self._scroll_delta,
            "horizontal": bool(self._scroll_horizontal),
            "window": {"title": self._scroll_window},
            "sensitive": bool(self._scroll_sensitive),
        })
        self._scroll_active = False
        self._scroll_delta = 0

    def _tick_mouse(self) -> None:
        x, y = _cursor()
        title = _window_title_at(x, y) or _foreground_title()
        sensitive = self._is_sensitive(title)
        now = time.time()
        # 任意鼠标键：左/右/中/侧键，都记成点击（不只左键）
        for vk, button in (
            (VK_LBUTTON, "left"),
            (VK_RBUTTON, "right"),
            (VK_MBUTTON, "middle"),
            (VK_XBUTTON1, "x1"),
            (VK_XBUTTON2, "x2"),
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
            if vk in (VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2):
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
