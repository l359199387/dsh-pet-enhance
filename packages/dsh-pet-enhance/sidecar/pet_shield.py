"""动手期间保护桌宠窗：写锁文件让 Helper 强制穿透，结束后再钉回置顶。

根因：自动化移鼠标经过桌宠时，Helper 的穿透兜底轮询会反复 setIgnoreMouseEvents；
Windows 上这会把真·置顶搞丢，宠物沉到别的窗后面，看起来像「卡没了」。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as w
import os
import time
from contextlib import contextmanager
from pathlib import Path

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

LOCK_NAME = "desktop-act.lock"
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

_PET_PATH_HINTS = ("dsh-pet", "electron-helper", "dsh_pet")
_PET_TITLE_RE_PARTS = ("dsh-pet", "桌宠")


def glance_home() -> Path:
    env = (os.environ.get("DSH_PET_ENHANCE_HOME") or os.environ.get("DSH_GLANCE_HOME") or "").strip()
    if env:
        return Path(env)
    pe = Path.home() / ".dsh" / "pet-enhance"
    legacy = Path.home() / ".dsh" / "glance"
    return pe if pe.exists() or not legacy.exists() else legacy


def act_lock_path() -> Path:
    return glance_home() / LOCK_NAME


def _window_title(hwnd: int) -> str:
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value or ""


def _process_image(pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return ""
    try:
        size = w.DWORD(512)
        buf = ctypes.create_unicode_buffer(size.value)
        # QueryFullProcessImageNameW
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return (buf.value or "").lower().replace("/", "\\")
    finally:
        kernel32.CloseHandle(handle)


def _looks_like_pet(hwnd: int) -> bool:
    title = _window_title(hwnd)
    low = title.lower()
    if any(p in low for p in _PET_TITLE_RE_PARTS) or "桌宠" in title:
        return True
    pid = w.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return False
    image = _process_image(int(pid.value))
    return any(h in image for h in _PET_PATH_HINTS)


def list_pet_hwnds() -> list[int]:
    found: list[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
    def enum_proc(hwnd, _lparam):
        if not user32.IsWindow(hwnd):
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        if user32.GetWindow(hwnd, 4):  # GW_OWNER：跳过工具子窗
            return True
        try:
            if _looks_like_pet(int(hwnd)):
                found.append(int(hwnd))
        except Exception:
            pass
        return True

    user32.EnumWindows(enum_proc, 0)
    return found


def reassert_pet_topmost(hwnds: list[int] | None = None) -> int:
    """把桌宠重新钉回 HWND_TOPMOST；返回成功个数。"""
    targets = hwnds if hwnds is not None else list_pet_hwnds()
    ok = 0
    for hwnd in targets:
        try:
            if not user32.IsWindow(hwnd):
                continue
            if user32.SetWindowPos(
                w.HWND(hwnd),
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ):
                ok += 1
        except Exception:
            pass
    return ok


@contextmanager
def pet_act_shield(*, dry_run: bool = False, settle_ms: float = 80.0):
    """写入 desktop-act.lock，让 Helper 强制穿透；退出时删锁并重钉置顶。"""
    if dry_run:
        yield {"locked": False, "hwnds": []}
        return

    path = act_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    hwnds = list_pet_hwnds()
    path.write_text("1", encoding="utf-8")
    try:
        if settle_ms > 0:
            time.sleep(float(settle_ms) / 1000.0)
        yield {"locked": True, "hwnds": hwnds, "path": str(path)}
    finally:
        try:
            path.unlink(missing_ok=True)
        except TypeError:
            # py3.7 兼容：无 missing_ok
            try:
                if path.exists():
                    path.unlink()
            except Exception:
                pass
        except Exception:
            pass
        reassert_pet_topmost(hwnds if hwnds else None)
        # 再等半拍，让 Helper 读到锁已消失
        if settle_ms > 0:
            time.sleep(min(0.05, float(settle_ms) / 1000.0))
