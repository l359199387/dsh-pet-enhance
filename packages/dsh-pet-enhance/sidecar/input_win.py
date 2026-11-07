"""Windows 输入注入（SendInput）+ failsafe。

与抓屏同进程、同 DPI。dry_run=True 时只校验参数、不碰真实输入（单测用）。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import time
from typing import Any, Callable

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
WHEEL_DELTA = 120

VK = {
    "ctrl": 0x11, "control": 0x11,
    "alt": 0x12, "shift": 0x10,
    "win": 0x5B, "meta": 0x5B, "cmd": 0x5B,
    "enter": 0x0D, "return": 0x0D,
    "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "insert": 0x2D, "capslock": 0x14,
}
for i in range(1, 13):
    VK[f"f{i}"] = 0x70 + i - 1
for c in "abcdefghijklmnopqrstuvwxyz":
    VK[c] = ord(c.upper())
for d in "0123456789":
    VK[d] = ord(d)


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", w.LONG), ("dy", w.LONG), ("mouseData", w.DWORD),
        ("dwFlags", w.DWORD), ("time", w.DWORD), ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", w.WORD), ("wScan", w.WORD), ("dwFlags", w.DWORD),
        ("time", w.DWORD), ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", w.DWORD), ("wParamL", w.WORD), ("wParamH", w.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", w.DWORD), ("u", _INPUTUNION)]


class POINT(ctypes.Structure):
    _fields_ = [("x", w.LONG), ("y", w.LONG)]


class FailsafeAbort(Exception):
    pass


class HostAbort(Exception):
    pass


def cursor_pos() -> tuple[int, int]:
    p = POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return int(p.x), int(p.y)


def screen_size() -> tuple[int, int]:
    return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))


def virtual_screen() -> tuple[int, int, int, int]:
    """返回 (vx, vy, vw, vh)：虚拟桌面原点与宽高（多屏含负坐标）。"""
    vw = int(user32.GetSystemMetrics(78))  # SM_CXVIRTUALSCREEN
    vh = int(user32.GetSystemMetrics(79))  # SM_CYVIRTUALSCREEN
    vx = int(user32.GetSystemMetrics(76))  # SM_XVIRTUALSCREEN
    vy = int(user32.GetSystemMetrics(77))  # SM_YVIRTUALSCREEN
    if vw <= 0 or vh <= 0:
        w, h = screen_size()
        return 0, 0, max(w, 2), max(h, 2)
    return vx, vy, max(vw, 2), max(vh, 2)


def near_origin(x: int, y: int, tol: int = 2) -> bool:
    return x <= tol and y <= tol


def _send(*inputs: INPUT) -> int:
    arr = (INPUT * len(inputs))(*inputs)
    return int(user32.SendInput(len(inputs), ctypes.byref(arr), ctypes.sizeof(INPUT)))


def _move_abs(x: int, y: int) -> None:
    # 绝对坐标必须按虚拟桌面归一化，并带 VIRTUALDESK；否则多屏/缩放时会偏一大截。
    vx, vy, vw, vh = virtual_screen()
    nx = int(max(vx, min(vx + vw - 1, x)))
    ny = int(max(vy, min(vy + vh - 1, y)))
    ax = int((nx - vx) * 65535 / (vw - 1))
    ay = int((ny - vy) * 65535 / (vh - 1))
    flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    mi = MOUSEINPUT(ax, ay, 0, flags, 0, 0)
    _send(INPUT(type=INPUT_MOUSE, mi=mi))


def _key_vk(vk: int, up: bool) -> None:
    flags = KEYEVENTF_KEYUP if up else 0
    ki = KEYBDINPUT(vk, 0, flags, 0, 0)
    _send(INPUT(type=INPUT_KEYBOARD, ki=ki))


def _key_unicode(ch: str, up: bool) -> None:
    flags = KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0)
    ki = KEYBDINPUT(0, ord(ch), flags, 0, 0)
    _send(INPUT(type=INPUT_KEYBOARD, ki=ki))


def _mouse_button(button: str, down: bool) -> None:
    b = (button or "left").lower()
    if b == "right":
        flag = MOUSEEVENTF_RIGHTDOWN if down else MOUSEEVENTF_RIGHTUP
    elif b == "middle":
        flag = MOUSEEVENTF_MIDDLEDOWN if down else MOUSEEVENTF_MIDDLEUP
    else:
        flag = MOUSEEVENTF_LEFTDOWN if down else MOUSEEVENTF_LEFTUP
    mi = MOUSEINPUT(0, 0, 0, flag, 0, 0)
    _send(INPUT(type=INPUT_MOUSE, mi=mi))


def _wheel(delta_steps: int) -> None:
    mi = MOUSEINPUT(0, 0, int(delta_steps) * WHEEL_DELTA, MOUSEEVENTF_WHEEL, 0, 0)
    _send(INPUT(type=INPUT_MOUSE, mi=mi))


def _check_guards(abort_event, dry_run: bool) -> None:
    if abort_event is not None and abort_event.is_set():
        raise HostAbort()
    if dry_run:
        return
    x, y = cursor_pos()
    if near_origin(x, y):
        raise FailsafeAbort()


def _sleep_ms(ms: float, abort_event, dry_run: bool) -> None:
    end = time.perf_counter() + max(0.0, float(ms)) / 1000.0
    while time.perf_counter() < end:
        _check_guards(abort_event, dry_run)
        time.sleep(0.01)


def move_to(x: int, y: int, duration_ms: int, abort_event, dry_run: bool) -> None:
    _check_guards(abort_event, dry_run)
    if dry_run:
        return
    x0, y0 = cursor_pos()
    steps = max(1, int(duration_ms / 8)) if duration_ms > 0 else 1
    for i in range(1, steps + 1):
        _check_guards(abort_event, dry_run)
        t = i / steps
        _move_abs(int(x0 + (x - x0) * t), int(y0 + (y - y0) * t))
        if duration_ms > 0:
            time.sleep(duration_ms / 1000.0 / steps)


def parse_keys(spec: str) -> list[int]:
    raw = str(spec or "").strip().lower()
    if not raw:
        raise ValueError("keys 为空")
    parts = [p.strip() for p in raw.replace("+", " ").split() if p.strip()]
    vks: list[int] = []
    for p in parts:
        if p not in VK:
            raise ValueError(f"不认识的键：{p}")
        vks.append(VK[p])
    return vks


def _clipboard_get() -> str | None:
    if not user32.OpenClipboard(None):
        return None
    try:
        handle = user32.GetClipboardData(13)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.wstring_at(ptr)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _clipboard_set(text: str) -> None:
    if not user32.OpenClipboard(None):
        raise RuntimeError("OpenClipboard 失败")
    try:
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        h = kernel32.GlobalAlloc(0x0002, len(data))
        if not h:
            raise RuntimeError("GlobalAlloc 失败")
        ptr = kernel32.GlobalLock(h)
        ctypes.memmove(ptr, data, len(data))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(13, h):
            raise RuntimeError("SetClipboardData 失败")
    finally:
        user32.CloseClipboard()


def type_text(text: str, abort_event, dry_run: bool) -> None:
    _check_guards(abort_event, dry_run)
    if dry_run:
        return
    s = str(text)
    if any(ord(ch) > 127 for ch in s):
        prev = _clipboard_get()
        try:
            _clipboard_set(s)
            _key_vk(0x11, False)
            _key_vk(0x56, False)
            _key_vk(0x56, True)
            _key_vk(0x11, True)
            time.sleep(0.05)
        finally:
            try:
                if prev is not None:
                    _clipboard_set(prev)
                elif user32.OpenClipboard(None):
                    try:
                        user32.EmptyClipboard()
                    finally:
                        user32.CloseClipboard()
            except Exception:
                pass
        return
    for ch in s:
        _check_guards(abort_event, dry_run)
        _key_unicode(ch, False)
        _key_unicode(ch, True)


def tap_keys(spec: str, abort_event, dry_run: bool) -> None:
    vks = parse_keys(spec)
    _check_guards(abort_event, dry_run)
    if dry_run:
        return
    for vk in vks:
        _key_vk(vk, False)
    for vk in reversed(vks):
        _key_vk(vk, True)


def focus_hwnd(hwnd: int, dry_run: bool) -> None:
    if dry_run:
        return
    user32.ShowWindow(int(hwnd), 9)  # SW_RESTORE
    if not user32.SetForegroundWindow(int(hwnd)):
        raise RuntimeError("SetForegroundWindow 失败")
    time.sleep(0.05)


def run_actions(
    actions: list,
    *,
    abort_event=None,
    dry_run: bool = False,
    resolve_focus: Callable[[str], dict] | None = None,
) -> dict[str, Any]:
    if not isinstance(actions, list) or not actions:
        raise ValueError("actions 必须是非空数组")

    done: list[dict] = []
    for raw in actions:
        if not isinstance(raw, dict):
            raise ValueError("每个 action 必须是对象")
        kind = str(raw.get("kind") or "").strip().lower()
        t0 = time.perf_counter()
        _check_guards(abort_event, dry_run)

        if kind == "move":
            move_to(int(raw["x"]), int(raw["y"]), int(raw.get("duration") or 180), abort_event, dry_run)
        elif kind in ("click", "double_click", "right_click"):
            btn = "right" if kind == "right_click" else str(raw.get("button") or "left")
            count = 2 if kind == "double_click" else int(raw.get("count") or 1)
            if "x" in raw and raw["x"] is not None and "y" in raw and raw["y"] is not None:
                move_to(int(raw["x"]), int(raw["y"]), int(raw.get("duration") or 0), abort_event, dry_run)
            for i in range(max(1, count)):
                _check_guards(abort_event, dry_run)
                if not dry_run:
                    _mouse_button(btn, True)
                    _mouse_button(btn, False)
                if i + 1 < count:
                    time.sleep(0.045)
        elif kind == "drag":
            move_to(int(raw["x"]), int(raw["y"]), int(raw.get("duration") or 100), abort_event, dry_run)
            if not dry_run:
                _mouse_button(str(raw.get("button") or "left"), True)
            move_to(
                int(raw["x2"]), int(raw["y2"]),
                int(raw.get("duration2") or raw.get("duration") or 180),
                abort_event, dry_run,
            )
            if not dry_run:
                _mouse_button(str(raw.get("button") or "left"), False)
        elif kind == "scroll":
            if "x" in raw and raw["x"] is not None and "y" in raw and raw["y"] is not None:
                move_to(int(raw["x"]), int(raw["y"]), 0, abort_event, dry_run)
            if not dry_run:
                _wheel(int(raw.get("delta") or raw.get("steps") or 0))
        elif kind == "type":
            type_text(str(raw.get("text") or ""), abort_event, dry_run)
        elif kind == "key":
            tap_keys(str(raw.get("keys") or raw.get("key") or ""), abort_event, dry_run)
        elif kind == "wait":
            _sleep_ms(float(raw.get("ms") or 0), abort_event, dry_run)
        elif kind == "screen":
            pass
        elif kind == "focus":
            if resolve_focus is None:
                raise ValueError("focus 需要 resolve_focus")
            info = resolve_focus(str(raw.get("window") or raw.get("match") or ""))
            focus_hwnd(int(info["hwnd"]), dry_run)
            done.append({
                "kind": kind,
                "ms": int((time.perf_counter() - t0) * 1000),
                "title": info.get("title"),
            })
            continue
        else:
            raise ValueError(f"未知 action.kind: {kind}")

        done.append({"kind": kind, "ms": int((time.perf_counter() - t0) * 1000)})

    if dry_run:
        cx, cy = 0, 0
    else:
        cx, cy = cursor_pos()
    return {"ok": True, "done": done, "aborted": False, "cursor": {"x": cx, "y": cy}, "dryRun": dry_run}
