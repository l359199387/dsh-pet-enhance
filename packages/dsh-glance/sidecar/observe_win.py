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
try:
    imm32 = ctypes.windll.imm32
except Exception:  # noqa: BLE001 — 非 Windows / 无 imm32
    imm32 = None

VK_LBUTTON = 0x01
VK_RBUTTON = 0x02
VK_MBUTTON = 0x04
VK_XBUTTON1 = 0x05  # 侧键后退
VK_XBUTTON2 = 0x06  # 侧键前进

# IME：组字时按键是拼音，不是正文；只收 RESULTSTR 上屏的汉字/英文
GCS_COMPSTR = 0x0008
GCS_RESULTSTR = 0x0800

# 滑轮：用 Raw Input（消息窗），不用 WH_MOUSE_LL——低级钩会拖慢整机鼠标
WM_INPUT = 0x00FF
RID_INPUT = 0x10000003
RIM_TYPEMOUSE = 0
RIDEV_INPUTSINK = 0x00000100
RIDEV_REMOVE = 0x00000001
RI_MOUSE_WHEEL = 0x0400
RI_MOUSE_HWHEEL = 0x0800
WHEEL_DELTA = 120
HWND_MESSAGE = -3
# 滑轮静止超过此时长 → 一次滚动手势结束（不按每格截图）
SCROLL_IDLE_SEC = 0.45

# 与 policy / episode 对齐的轻量敏感标题
_SENSITIVE_TITLE_RE = None


class RAWINPUTDEVICE(ctypes.Structure):
    _fields_ = [
        ("usUsagePage", ctypes.c_ushort),
        ("usUsage", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("hwndTarget", w.HWND),
    ]


class RAWINPUTHEADER(ctypes.Structure):
    _fields_ = [
        ("dwType", w.DWORD),
        ("dwSize", w.DWORD),
        ("hDevice", w.HANDLE),
        ("wParam", w.WPARAM),
    ]


class _RAWMOUSE_BUTTONS(ctypes.Structure):
    _fields_ = [
        ("usButtonFlags", ctypes.c_ushort),
        ("usButtonData", ctypes.c_ushort),
    ]


class _RAWMOUSE_UNION(ctypes.Union):
    _fields_ = [
        ("ulButtons", ctypes.c_ulong),
        ("buttons", _RAWMOUSE_BUTTONS),
    ]


class RAWMOUSE(ctypes.Structure):
    _fields_ = [
        ("usFlags", ctypes.c_ushort),
        ("u", _RAWMOUSE_UNION),
        ("ulRawButtons", ctypes.c_ulong),
        ("lLastX", ctypes.c_long),
        ("lLastY", ctypes.c_long),
        ("ulExtraInformation", ctypes.c_ulong),
    ]


class RAWINPUT(ctypes.Structure):
    _fields_ = [
        ("header", RAWINPUTHEADER),
        ("mouse", RAWMOUSE),
    ]


user32.RegisterRawInputDevices.argtypes = [
    ctypes.POINTER(RAWINPUTDEVICE),
    ctypes.c_uint,
    ctypes.c_uint,
]
user32.RegisterRawInputDevices.restype = w.BOOL
user32.GetRawInputData.argtypes = [
    w.HANDLE,
    ctypes.c_uint,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_uint),
    ctypes.c_uint,
]
user32.GetRawInputData.restype = ctypes.c_uint


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


def _is_pet_chrome_title(title: str) -> bool:
    t = title or ""
    low = t.lower()
    return ("dsh-pet" in low) or ("桌宠" in t)


def _ime_state(hwnd: int) -> tuple[str, bool]:
    """返回 (刚上屏的成词, 是否处于 IME 开/组字中应忽略拉丁键)。"""
    if not imm32 or not hwnd:
        return "", False
    try:
        himc = imm32.ImmGetContext(w.HWND(hwnd))
    except Exception:
        return "", False
    if not himc:
        return "", False
    try:
        open_ime = bool(imm32.ImmGetOpenStatus(himc))
        result = ""
        n = int(imm32.ImmGetCompositionStringW(himc, GCS_RESULTSTR, None, 0) or 0)
        if n > 0:
            buf = ctypes.create_unicode_buffer(n // 2 + 2)
            imm32.ImmGetCompositionStringW(himc, GCS_RESULTSTR, buf, n + 2)
            result = buf.value or ""
        n_comp = int(imm32.ImmGetCompositionStringW(himc, GCS_COMPSTR, None, 0) or 0)
        # 中文 IME 打开时，物理键是拼音/选词，不能当正文；成词走 RESULTSTR
        skip_latin = open_ime or n_comp > 0
        return result, skip_latin
    except Exception:
        return "", False
    finally:
        try:
            imm32.ImmReleaseContext(w.HWND(hwnd), himc)
        except Exception:
            pass


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
        self._last_ime_result = ""
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
        self._raw_hwnd = None
        self._wheel_raw: queue.Queue[tuple[int, int, int, bool]] = queue.Queue(maxsize=256)

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
        self._teardown_raw_input()
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
        self._setup_raw_input()
        try:
            while not self._stop.is_set():
                try:
                    self._pump_messages()
                    self._drain_wheel_raw()
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
            self._teardown_raw_input()

    def _setup_raw_input(self) -> None:
        """消息窗 + Raw Input 只收鼠标；移动不进系统钩，避免卡顿。"""
        try:
            self._raw_hwnd = user32.CreateWindowExW(
                0,
                "STATIC",
                "glance-observe-raw",
                0,
                0, 0, 0, 0,
                HWND_MESSAGE,
                None,
                None,
                None,
            )
            if not self._raw_hwnd:
                return
            rid = RAWINPUTDEVICE()
            rid.usUsagePage = 0x01  # generic desktop
            rid.usUsage = 0x02  # mouse
            rid.dwFlags = RIDEV_INPUTSINK
            rid.hwndTarget = self._raw_hwnd
            if not user32.RegisterRawInputDevices(ctypes.byref(rid), 1, ctypes.sizeof(RAWINPUTDEVICE)):
                user32.DestroyWindow(self._raw_hwnd)
                self._raw_hwnd = None
        except Exception:
            self._raw_hwnd = None

    def _teardown_raw_input(self) -> None:
        hwnd = self._raw_hwnd
        self._raw_hwnd = None
        if not hwnd:
            return
        try:
            rid = RAWINPUTDEVICE()
            rid.usUsagePage = 0x01
            rid.usUsage = 0x02
            rid.dwFlags = RIDEV_REMOVE
            rid.hwndTarget = None
            user32.RegisterRawInputDevices(ctypes.byref(rid), 1, ctypes.sizeof(RAWINPUTDEVICE))
        except Exception:
            pass
        try:
            user32.DestroyWindow(hwnd)
        except Exception:
            pass

    def _pump_messages(self) -> None:
        msg = w.MSG()
        for _ in range(64):
            if not user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 1):  # PM_REMOVE
                break
            if int(msg.message) == WM_INPUT:
                self._handle_raw_input(msg.lParam)
                continue
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def _handle_raw_input(self, lparam) -> None:
        try:
            size = ctypes.c_uint(0)
            hdr = ctypes.sizeof(RAWINPUTHEADER)
            user32.GetRawInputData(
                lparam, RID_INPUT, None, ctypes.byref(size), hdr,
            )
            if size.value <= 0 or size.value > 4096:
                return
            buf = (ctypes.c_byte * size.value)()
            got = user32.GetRawInputData(
                lparam, RID_INPUT, ctypes.byref(buf), ctypes.byref(size), hdr,
            )
            if got == 0xFFFFFFFF or got == 0:
                return
            ri = ctypes.cast(buf, ctypes.POINTER(RAWINPUT)).contents
            if ri.header.dwType != RIM_TYPEMOUSE:
                return
            flags = int(ri.mouse.u.buttons.usButtonFlags)
            data = ctypes.c_short(ri.mouse.u.buttons.usButtonData).value
            horizontal = False
            if flags & RI_MOUSE_WHEEL:
                horizontal = False
            elif flags & RI_MOUSE_HWHEEL:
                horizontal = True
            else:
                return
            steps = int(data / WHEEL_DELTA) if WHEEL_DELTA else 0
            if steps == 0 and data != 0:
                steps = 1 if data > 0 else -1
            x, y = _cursor()
            try:
                self._wheel_raw.put_nowait((x, y, int(steps), horizontal))
            except queue.Full:
                pass
        except Exception:
            pass

    def _drain_wheel_raw(self) -> None:
        while True:
            try:
                x, y, steps, horizontal = self._wheel_raw.get_nowait()
            except queue.Empty:
                break
            try:
                self._on_wheel(x, y, steps, horizontal)
            except Exception:
                pass

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

    def _append_type(self, text: str, title: str, sensitive: bool) -> None:
        if not text:
            return
        if not self._type_buf:
            self._type_window = title
            self._type_sensitive = sensitive
        else:
            self._type_sensitive = self._type_sensitive or sensitive
        self._type_buf += text
        self._type_at = time.time()

    def _sync_prev_keys(self) -> None:
        """IME 吞键时也要更新边沿，避免松手后一次补发一串。"""
        for vk in list(range(0x08, 0x93)):
            if vk in (0x10, 0x11, 0x12, 0x5B, 0x5C):
                continue
            if vk in (VK_LBUTTON, VK_RBUTTON, VK_MBUTTON, VK_XBUTTON1, VK_XBUTTON2):
                continue
            self._prev_keys[vk] = _key_down(vk)

    def _tick_keys(self) -> None:
        shift = _key_down(0x10)
        ctrl = _key_down(0x11)
        alt = _key_down(0x12)
        win = _key_down(0x5B)
        title = _foreground_title()
        sensitive = self._is_sensitive(title)
        hwnd = int(user32.GetForegroundWindow() or 0)

        # 对桌宠说话（「我教完了」等）不是业务输入，绝不能进自动化
        if _is_pet_chrome_title(title):
            self._flush_type()
            self._sync_prev_keys()
            return

        ime_result, ime_skip_latin = _ime_state(hwnd)
        if ime_result and ime_result != self._last_ime_result:
            # 同一成词可能连读几拍；只在变化时追加
            delta = ime_result
            if self._last_ime_result and ime_result.startswith(self._last_ime_result):
                delta = ime_result[len(self._last_ime_result):]
            self._last_ime_result = ime_result
            if delta:
                self._append_type(delta, title, sensitive)
        elif not ime_result:
            self._last_ime_result = ""

        if ime_skip_latin and not (ctrl or alt or win):
            # 仍允许记组合键；纯拼音/选词数字丢掉
            self._sync_prev_keys()
            return

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
            self._append_type(ch, title, sensitive)


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
