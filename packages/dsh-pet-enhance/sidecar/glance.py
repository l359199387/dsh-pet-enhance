#!/usr/bin/env python3
"""dsh-pet-enhance sidecar：抓屏 + 输入（C1）。

协议：stdin/stdout 各一行一个 JSON，UTF-8，请求带 id，响应回同一个 id。
abort 在读线程里立刻置位，可打断正在跑的 input 串。
"""

from __future__ import annotations

import base64
import io
import json
import os
import queue
import sys
import threading
import time
import traceback
from difflib import SequenceMatcher

VERSION = "0.3.0"
PW_RENDERFULLCONTENT = 2
DWMWA_EXTENDED_FRAME_BOUNDS = 9
BLACK_RANGE_MAX = 8
BLACK_MEAN_MAX = 12
# 32px 以下的多半是托盘/覆盖层的隐形窗；列出来只会把候选标题搅浑。
MIN_WINDOW_SIDE = 32
# 有标题但不是用户会想「看」的窗口：桌面壳、覆盖层、托盘。留着会让 WINDOW_NOT_FOUND
# 的候选变成一堆垃圾（实测候选里出现过 Program Manager / dummyLayeredWnd）。
TITLE_DENYLIST = {
    "program manager",
    "dummylayeredwnd",
    "nvidia geforce overlay",
    "trayrocketview",
}

_stats = {
    "started_at": time.time(),
    "requests": 0,
    "captures": 0,
    "diffs": 0,
    "mosaics": 0,
    "errors": 0,
}

# 流式变化分：跨 capture/diff 请求记住上一帧 HSV（同进程）。
_frame_scorer = None


def _get_scorer():
    global _frame_scorer
    if _frame_scorer is None:
        from diff_score import FrameScorer
        _frame_scorer = FrameScorer()
    return _frame_scorer


def _decode_png_b64(raw: str):
    from PIL import Image

    data = base64.b64decode(str(raw or ""), validate=False)
    return Image.open(io.BytesIO(data)).convert("RGB")


def _apply_privacy(image, capture_rect, extra_patterns=None):
    from privacy_mask import apply_mask, compile_patterns

    pats = compile_patterns(extra_patterns)
    try:
        windows = list_windows()
    except Exception:
        windows = []
    return apply_mask(
        image,
        capture_rect=capture_rect,
        windows=windows,
        patterns=pats,
    )


def _reconfigure_stdio() -> None:
    # 中文窗口标题必须走 UTF-8；默认控制台编码会把标题弄成乱码。
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")


def _set_dpi_aware() -> bool:
    try:
        import ctypes
        return bool(ctypes.windll.user32.SetProcessDPIAware())
    except Exception:
        return False


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _err(code: str, message: str, **extra) -> dict:
    _stats["errors"] += 1
    body = {"code": code, "message": message}
    body.update(extra)
    return {"ok": False, "error": body}


def _png_b64(image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _jpeg_b64(image, quality: int = 80) -> str:
    buf = io.BytesIO()
    rgb = image.convert("RGB")
    rgb.save(buf, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _resize_max_width(image, max_width: int | None):
    if not max_width or max_width <= 0 or image.width <= max_width:
        return image
    scale = max_width / float(image.width)
    h = max(1, int(round(image.height * scale)))
    w = max(1, int(round(image.width * scale)))
    return image.resize((w, h), resample=_pil_resample())


def _pil_resample():
    from PIL import Image
    return getattr(Image, "Resampling", Image).LANCZOS


def _is_near_black(image) -> bool:
    # 硬件加速窗口 PrintWindow 常返回全黑；灰度极差 < 8 且均值近黑 → 判抓不到。
    gray = image.convert("L")
    # 缩到很小再统计，避免对大图扫像素。
    sample = gray.resize((64, max(1, int(64 * gray.height / max(1, gray.width)))), resample=_pil_resample())
    extrema = sample.getextrema()
    if not extrema:
        return True
    lo, hi = extrema
    if (hi - lo) >= BLACK_RANGE_MAX:
        return False
    # getextrema 已经很暗时，再看均值是否贴零。
    hist = sample.histogram()
    total = sum(hist) or 1
    mean = sum(i * hist[i] for i in range(256)) / total
    return mean <= BLACK_MEAN_MAX


def _screen_info() -> dict:
    import ctypes
    user32 = ctypes.windll.user32
    w = int(user32.GetSystemMetrics(0))
    h = int(user32.GetSystemMetrics(1))
    # SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN / SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN
    vw = int(user32.GetSystemMetrics(78))
    vh = int(user32.GetSystemMetrics(79))
    vx = int(user32.GetSystemMetrics(76))
    vy = int(user32.GetSystemMetrics(77))
    if vw <= 0 or vh <= 0:
        vw, vh, vx, vy = w, h, 0, 0
    return {
        "w": w,
        "h": h,
        "virtual": {"x": vx, "y": vy, "w": vw, "h": vh},
        "dpiAware": True,
    }


def _cursor_pos() -> dict:
    import ctypes
    from ctypes import wintypes

    class POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    pt = POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    return {"x": int(pt.x), "y": int(pt.y)}


def _active_window() -> dict | None:
    import ctypes
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    title = _window_title(hwnd)
    rect = _window_rect(hwnd)
    pid = _window_pid(hwnd)
    return {
        "hwnd": int(hwnd),
        "title": title,
        "pid": pid,
        "rect": list(rect) if rect else None,
    }


def _window_at_point(x: int, y: int) -> dict | None:
    """点下方的顶层窗（用于黑名单：前台常是桌宠，真正要点的是下面的记事本）。"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    pt = wintypes.POINT(int(x), int(y))
    hwnd = user32.WindowFromPoint(pt)
    if not hwnd:
        return None
    # GA_ROOT = 2：爬到顶层，避免拿到编辑控件子窗而无标题
    root = user32.GetAncestor(hwnd, 2)
    if root:
        hwnd = root
    title = _window_title(hwnd)
    rect = _window_rect(hwnd)
    pid = _window_pid(hwnd)
    return {
        "hwnd": int(hwnd),
        "title": title,
        "pid": pid,
        "rect": list(rect) if rect else None,
    }


def _window_title(hwnd: int) -> str:
    import ctypes
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    return buf.value or ""


def _window_pid(hwnd: int) -> int:
    import ctypes
    pid = ctypes.c_ulong(0)
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def _window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    import ctypes
    from ctypes import wintypes

    rect = wintypes.RECT()
    # DWM 扩展边框才是真实可见边界；GetWindowRect 会带上不可见阴影边。
    try:
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            wintypes.HWND(hwnd),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(rect),
            ctypes.sizeof(rect),
        )
        if hr == 0:
            return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
    except Exception:
        pass
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)


def _is_capturable(hwnd: int) -> bool:
    import ctypes
    user32 = ctypes.windll.user32
    if not user32.IsWindow(hwnd):
        return False
    if not user32.IsWindowVisible(hwnd):
        return False
    if user32.IsIconic(hwnd):
        return False
    # 只要有标题的顶层窗；工具窗/幽灵窗通常无标题。
    title = _window_title(hwnd)
    if not title.strip():
        return False
    if title.strip().lower() in TITLE_DENYLIST:
        return False
    # 跳过 cloaked（UWP 挂起等）
    try:
        cloaked = ctypes.c_int(0)
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)
        )
        if hr == 0 and cloaked.value:
            return False
    except Exception:
        pass
    return True


def list_windows() -> list[dict]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    results: list[dict] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        if not _is_capturable(hwnd):
            return True
        rect = _window_rect(hwnd)
        if not rect:
            return True
        left, top, right, bottom = rect
        if right - left < MIN_WINDOW_SIDE or bottom - top < MIN_WINDOW_SIDE:
            return True
        results.append({
            "hwnd": int(hwnd),
            "title": _window_title(hwnd),
            "pid": _window_pid(hwnd),
            "rect": [left, top, right, bottom],
        })
        return True

    user32.EnumWindows(enum_proc, 0)
    return results


def score_title(query: str, title: str) -> float:
    q = query.strip().lower()
    t = title.strip().lower()
    if not q or not t:
        return 0.0
    if q == t:
        return 1.0
    if q in t:
        # 越短越具体
        return 0.85 + 0.1 * (len(q) / max(1, len(t)))
    return SequenceMatcher(None, q, t).ratio()


def resolve_window(match: str) -> tuple[dict | None, list[str], str | None]:
    """返回 (window, candidate_titles, error_code)。"""
    query = str(match or "").strip()
    if not query:
        return None, [], "BAD_REQUEST"
    windows = list_windows()
    if not windows:
        return None, [], "WINDOW_NOT_FOUND"

    ranked = sorted(
        ((score_title(query, w["title"]), w) for w in windows),
        key=lambda item: item[0],
        reverse=True,
    )
    best_score, best = ranked[0]
    candidates = [w["title"] for _, w in ranked[:3]]

    if best_score < 0.45:
        return None, candidates, "WINDOW_NOT_FOUND"

    # 多个几乎同分的包含匹配 → 歧义
    near = [w for s, w in ranked if s >= best_score - 0.02 and s >= 0.85]
    if len(near) > 1 and best_score < 1.0:
        # 前台窗优先
        active = _active_window()
        if active:
            for w in near:
                if w["hwnd"] == active.get("hwnd"):
                    return w, [x["title"] for x in near[:3]], None
        return None, [w["title"] for w in near[:3]], "WINDOW_AMBIGUOUS"

    return best, candidates, None


def _hbitmap_to_image(hdc_mem, hbmp, width: int, height: int):
    import ctypes
    from ctypes import wintypes
    from PIL import Image

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER)]

    gdi32 = ctypes.windll.gdi32
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = width
    bmi.bmiHeader.biHeight = -height  # top-down
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0

    buf_len = width * height * 4
    buf = (ctypes.c_ubyte * buf_len)()
    got = gdi32.GetDIBits(hdc_mem, hbmp, 0, height, ctypes.byref(buf), ctypes.byref(bmi), 0)
    if got != height:
        raise RuntimeError("GetDIBits failed")

    raw = bytes(buf)
    # BGRA → RGB
    rgb = bytearray(width * height * 3)
    for i in range(width * height):
        b = raw[i * 4]
        g = raw[i * 4 + 1]
        r = raw[i * 4 + 2]
        rgb[i * 3] = r
        rgb[i * 3 + 1] = g
        rgb[i * 3 + 2] = b
    return Image.frombytes("RGB", (width, height), bytes(rgb))


def capture_window_hwnd(hwnd: int):
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    rect = _window_rect(hwnd)
    if not rect:
        raise RuntimeError("window has no rect")
    left, top, right, bottom = rect
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        raise RuntimeError("window has empty area")

    hdc_screen = user32.GetDC(0)
    if not hdc_screen:
        raise RuntimeError("GetDC failed")
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    old = gdi32.SelectObject(hdc_mem, hbmp)
    try:
        ok = user32.PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT)
        if not ok:
            # 部分窗口 PW_RENDERFULLCONTENT 失败时退到普通 PrintWindow
            ok = user32.PrintWindow(hwnd, hdc_mem, 0)
        if not ok:
            raise RuntimeError("PrintWindow failed")
        image = _hbitmap_to_image(hdc_mem, hbmp, width, height)
    finally:
        gdi32.SelectObject(hdc_mem, old)
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(0, hdc_screen)

    return image, (left, top, right, bottom)


def screen_bbox(region: dict | None = None) -> tuple[int, int, int, int]:
    screen = _screen_info()
    virtual = screen["virtual"]
    if region:
        x = int(region["x"])
        y = int(region["y"])
        w = int(region["w"])
        h = int(region["h"])
        if w <= 0 or h <= 0:
            raise ValueError("region empty")
        return x, y, x + w, y + h
    return (
        virtual["x"],
        virtual["y"],
        virtual["x"] + virtual["w"],
        virtual["y"] + virtual["h"],
    )


def capture_screen_image(region: dict | None = None):
    from PIL import ImageGrab

    bbox = screen_bbox(region)
    image = ImageGrab.grab(bbox=bbox, all_screens=True)
    return image


def parse_region(value) -> dict | None:
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        return {
            "x": int(value["x"]),
            "y": int(value["y"]),
            "w": int(value["w"]),
            "h": int(value["h"]),
        }
    text = str(value).strip()
    parts = [p.strip() for p in text.replace(" ", ",").split(",") if p.strip()]
    if len(parts) != 4:
        raise ValueError('region 必须是 "x,y,w,h"')
    x, y, w, h = (int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3]))
    return {"x": x, "y": y, "w": w, "h": h}


def handle_hello(_req: dict) -> dict:
    try:
        import PIL  # noqa: F401
        from PIL import ImageGrab  # noqa: F401
    except Exception as e:
        return _err("NO_PIL", f"Pillow 不可用：{e}")

    screen = _screen_info()
    return {
        "ok": True,
        "version": VERSION,
        "screen": {
            "w": screen["w"],
            "h": screen["h"],
            "dpi": 1.0,
            "virtual": screen["virtual"],
            "dpiAware": True,
        },
        "engine": "pillow",
        "input": True,
    }


def handle_windows(_req: dict) -> dict:
    return {"ok": True, "windows": list_windows()}


def handle_capture(req: dict) -> dict:
    source = req.get("source") or {"kind": "screen"}
    kind = str(source.get("kind") or "screen").lower()
    max_width = req.get("max_width")
    want_score = bool(req.get("score") or req.get("with_score"))
    mask = req.get("mask", True)
    extra_mask = req.get("mask_patterns") or req.get("maskPatterns")
    try:
        max_width_i = int(max_width) if max_width is not None else None
    except (TypeError, ValueError):
        return _err("BAD_REQUEST", "max_width 必须是整数")

    t0 = time.perf_counter()
    active = _active_window()
    cursor = _cursor_pos()
    meta_window = None
    capture_rect = None
    masked_titles: list[str] = []

    try:
        if kind == "window":
            match = source.get("match") or source.get("title") or source.get("window")
            win, candidates, code = resolve_window(str(match or ""))
            if code == "BAD_REQUEST":
                return _err("BAD_REQUEST", "window 抓取需要 source.match")
            if code == "WINDOW_NOT_FOUND":
                return _err(
                    "WINDOW_NOT_FOUND",
                    f"没有标题匹配 {match!r} 的窗口",
                    candidates=candidates,
                )
            if code == "WINDOW_AMBIGUOUS":
                return _err(
                    "WINDOW_AMBIGUOUS",
                    f"有多个窗口匹配 {match!r}，请写得更具体",
                    candidates=candidates,
                )
            assert win is not None
            image, rect = capture_window_hwnd(win["hwnd"])
            capture_rect = tuple(rect)
            meta_window = {
                "hwnd": win["hwnd"],
                "title": win["title"],
                "pid": win["pid"],
                "rect": list(rect),
            }
            if _is_near_black(image):
                return _err(
                    "CAPTURE_FAILED",
                    f"窗口 {win['title']!r} 抓到近黑图（常见于硬件加速窗口），请改抓整屏或换窗口",
                    candidates=[win["title"]],
                )
        elif kind == "screen":
            region = parse_region(source.get("region"))
            capture_rect = screen_bbox(region)
            image = capture_screen_image(region)
        else:
            return _err("BAD_REQUEST", f"未知 source.kind: {kind}")
    except ValueError as e:
        return _err("BAD_REQUEST", str(e))
    except Exception as e:
        return _err("CAPTURE_FAILED", f"抓屏失败：{e}")

    if mask is not False and capture_rect is not None:
        try:
            image, masked_titles = _apply_privacy(image, capture_rect, extra_mask)
        except Exception:
            masked_titles = []

    # 遮罩后再打分：与模型/缩略图看到的画面一致。
    score_val = None
    if want_score:
        try:
            score_val = _get_scorer().push_image(image)
        except Exception:
            score_val = None

    image = _resize_max_width(image, max_width_i)
    png = _png_b64(image)
    ms = int((time.perf_counter() - t0) * 1000)
    _stats["captures"] += 1
    out = {
        "ok": True,
        "png": png,
        "w": image.width,
        "h": image.height,
        "ms": ms,
        "active": active,
        "cursor": cursor,
        "score": 0.0 if score_val is None else float(score_val),
        "scoreReady": score_val is not None,
        "masked": masked_titles,
    }
    if meta_window is not None:
        out["window"] = meta_window
    return out


def handle_diff(req: dict) -> dict:
    """比较两张 PNG，或对流式 scorer 推一帧 / 重置。"""
    from diff_score import score_images

    t0 = time.perf_counter()
    if req.get("reset"):
        _get_scorer().reset()
        return {"ok": True, "reset": True, "ms": int((time.perf_counter() - t0) * 1000)}

    png_a = req.get("pngA") or req.get("png_a")
    png_b = req.get("pngB") or req.get("png_b")
    png = req.get("png")

    try:
        if png_a is not None and png_b is not None:
            img_a = _decode_png_b64(png_a)
            img_b = _decode_png_b64(png_b)
            score = float(score_images(img_a, img_b))
            _stats["diffs"] += 1
            return {
                "ok": True,
                "score": score,
                "first": False,
                "ms": int((time.perf_counter() - t0) * 1000),
            }

        if png is not None:
            img = _decode_png_b64(png)
            score = _get_scorer().push_image(img)
            _stats["diffs"] += 1
            return {
                "ok": True,
                "score": 0.0 if score is None else float(score),
                "first": score is None,
                "ms": int((time.perf_counter() - t0) * 1000),
            }
    except Exception as e:
        return _err("DIFF_FAILED", f"变化分失败：{e}")

    return _err("BAD_REQUEST", "diff 需要 png，或 pngA+pngB，或 reset:true")


def handle_mosaic(req: dict) -> dict:
    """把多帧 PNG 拼成一张（最多 4 格，布局按源比例自适应），宽度对齐 42。更多帧由上层拆成多张。"""
    from mosaic import MAX_FRAMES, compose_mosaic, encode_png, normalize_quality

    frames_raw = req.get("frames")
    if not isinstance(frames_raw, list) or not frames_raw:
        return _err("BAD_REQUEST", "mosaic 需要 frames: [{png, label?}, ...]")

    quality = normalize_quality(req.get("quality"))
    packed = []
    labels = []
    try:
        for i, item in enumerate(frames_raw[:MAX_FRAMES]):
            if isinstance(item, dict):
                png = item.get("png")
                label = item.get("label") or str(i + 1)
            else:
                png = item
                label = str(i + 1)
            if not png:
                return _err("BAD_REQUEST", f"frames[{i}] 缺 png")
            packed.append({"image": _decode_png_b64(png), "label": label})
            labels.append(str(label))
        image, meta = compose_mosaic(packed, quality=quality, labels=labels)
        png_bytes = encode_png(image)
    except Exception as e:
        return _err("MOSAIC_FAILED", f"拼图失败：{e}")

    _stats["mosaics"] += 1
    return {
        "ok": True,
        "png": base64.b64encode(png_bytes).decode("ascii"),
        "w": meta["w"],
        "h": meta["h"],
        "quality": meta["quality"],
        "cols": meta["cols"],
        "rows": meta["rows"],
        "frames": meta["frames"],
        "ms": 0,
    }


def handle_stack(req: dict) -> dict:
    """多张已合成的拼图竖向叠成一张（每张保持原布局清晰度）。"""
    from mosaic import encode_png, stack_vertical

    pngs_raw = req.get("pngs")
    if not isinstance(pngs_raw, list) or not pngs_raw:
        return _err("BAD_REQUEST", "stack 需要 pngs: [base64, ...]")

    try:
        images = []
        for i, item in enumerate(pngs_raw):
            b64 = item.get("png") if isinstance(item, dict) else item
            if not b64:
                return _err("BAD_REQUEST", f"pngs[{i}] 缺 png")
            images.append(_decode_png_b64(b64))
        image = stack_vertical(images, gap=int(req.get("gap") or 8))
        png_bytes = encode_png(image)
    except Exception as e:
        return _err("STACK_FAILED", f"叠图失败：{e}")

    return {
        "ok": True,
        "png": base64.b64encode(png_bytes).decode("ascii"),
        "w": image.width,
        "h": image.height,
        "sheets": len(images),
        "ms": 0,
    }


def handle_thumb(req: dict) -> dict:
    width = int(req.get("width") or 320)
    if width < 32 or width > 1280:
        return _err("BAD_REQUEST", "thumb.width 范围 32–1280")
    t0 = time.perf_counter()
    masked_titles: list[str] = []
    try:
        bbox = screen_bbox(None)
        image = capture_screen_image(None)
        if req.get("mask", True) is not False:
            try:
                image, masked_titles = _apply_privacy(image, bbox)
            except Exception:
                masked_titles = []
        image = _resize_max_width(image, width)
        jpeg = _jpeg_b64(image)
    except Exception as e:
        return _err("CAPTURE_FAILED", f"缩略图失败：{e}")
    return {
        "ok": True,
        "jpeg": jpeg,
        "w": image.width,
        "h": image.height,
        "ms": int((time.perf_counter() - t0) * 1000),
        "masked": masked_titles,
    }


def handle_stats(req: dict) -> dict:
    cursor = _cursor_pos()
    ax = req.get("x")
    ay = req.get("y")
    if ax is not None and ay is not None:
        try:
            at_point = _window_at_point(int(ax), int(ay))
        except Exception:
            at_point = _window_at_point(cursor["x"], cursor["y"])
    else:
        at_point = _window_at_point(cursor["x"], cursor["y"])
    return {
        "ok": True,
        "stats": {
            **_stats,
            "uptimeMs": int((time.time() - _stats["started_at"]) * 1000),
        },
        "screen": _screen_info(),
        "cursor": cursor,
        "active": _active_window(),
        "atPoint": at_point,
    }


def handle_quit(_req: dict) -> dict:
    return {"ok": True, "bye": True}


_abort_event = threading.Event()


def handle_abort(_req: dict) -> dict:
    _abort_event.set()
    return {"ok": True, "aborted": True}


def _want_dry_run(req: dict) -> bool:
    if req.get("dryRun") is True or req.get("dry_run") is True:
        return True
    return os.environ.get("DSH_GLANCE_INPUT_DRY_RUN", "").strip() in ("1", "true", "yes")


def handle_input(req: dict) -> dict:
    from input_win import FailsafeAbort, HostAbort, cursor_pos, run_actions

    actions = req.get("actions")
    dry_run = _want_dry_run(req)

    def resolve_focus(match: str) -> dict:
        win, candidates, code = resolve_window(str(match or ""))
        if code == "BAD_REQUEST":
            raise ValueError("focus 需要 window/match")
        if code != "ok" or win is None:
            err = _err(code or "WINDOW_NOT_FOUND", f"无法聚焦：{match}", candidates=candidates or [])
            raise RuntimeError(json.dumps(err, ensure_ascii=False))
        return win

    # 只读 screen：不需 failsafe
    if (
        isinstance(actions, list)
        and len(actions) == 1
        and str((actions[0] or {}).get("kind") or "").lower() == "screen"
    ):
        x, y = cursor_pos()
        return {
            "ok": True,
            "done": [{"kind": "screen", "ms": 0}],
            "aborted": False,
            "cursor": {"x": x, "y": y},
            "screen": _screen_info(),
            "dryRun": dry_run,
        }

    _abort_event.clear()
    try:
        from pet_shield import pet_act_shield

        # 动手期间锁住桌宠穿透，避免 Helper 轮询翻 setIgnoreMouseEvents 弄丢置顶（表现为「卡没了」）
        with pet_act_shield(dry_run=dry_run):
            return run_actions(
                actions if isinstance(actions, list) else [],
                abort_event=_abort_event,
                dry_run=dry_run,
                resolve_focus=resolve_focus,
            )
    except FailsafeAbort:
        x, y = cursor_pos()
        return {
            "ok": False,
            "aborted": True,
            "cause": "failsafe",
            "error": {"code": "FAILSAFE", "message": "光标在左上角，已急停"},
            "done": [],
            "cursor": {"x": x, "y": y},
        }
    except HostAbort:
        x, y = cursor_pos()
        return {
            "ok": False,
            "aborted": True,
            "cause": "abort",
            "error": {"code": "ABORTED", "message": "Host 发了 abort"},
            "done": [],
            "cursor": {"x": x, "y": y},
        }
    except RuntimeError as e:
        # resolve_focus 塞进来的 JSON 错误
        try:
            parsed = json.loads(str(e))
            if isinstance(parsed, dict) and parsed.get("error"):
                return parsed
        except Exception:
            pass
        return _err("BAD_REQUEST", str(e))
    except ValueError as e:
        return _err("BAD_REQUEST", str(e))
    except Exception as e:
        return _err("INPUT_FAILED", f"输入失败：{e}")


def handle_observe(req: dict) -> dict:
    from observe_win import handle_observe as _obs
    return _obs(req)


HANDLERS = {
    "hello": handle_hello,
    "capture": handle_capture,
    "windows": handle_windows,
    "thumb": handle_thumb,
    "stats": handle_stats,
    "quit": handle_quit,
    "abort": handle_abort,
    "input": handle_input,
    "observe": handle_observe,
    "diff": handle_diff,
    "mosaic": handle_mosaic,
    "stack": handle_stack,
}


def handle(req: dict) -> dict:
    if not isinstance(req, dict):
        return _err("BAD_REQUEST", "请求必须是 JSON 对象")
    req_id = req.get("id")
    op = str(req.get("op") or "").strip().lower()
    _stats["requests"] += 1

    handler = HANDLERS.get(op)
    if handler is None:
        body = _err("BAD_REQUEST", f"未知 op: {op or '(空)'}")
        body["id"] = req_id
        return body

    try:
        result = handler(req)
    except Exception as e:
        result = _err("CAPTURE_FAILED", f"未处理异常：{e}")
        sys.stderr.write(traceback.format_exc() + "\n")
        sys.stderr.flush()

    result["id"] = req_id
    return result


def main() -> int:
    _reconfigure_stdio()
    _set_dpi_aware()

    # 读线程可随时处理 abort；工作线程串行执行其它 op（含可能很长的 input）。
    req_q: queue.Queue = queue.Queue()
    stop_flag = threading.Event()

    def reader() -> None:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as e:
                _emit({"id": None, "ok": False, "error": {"code": "BAD_REQUEST", "message": f"JSON 无法解析：{e}"}})
                continue
            op = str(req.get("op") or "").strip().lower()
            if op == "abort":
                resp = handle(req)
                _emit(resp)
                continue
            req_q.put(req)
        stop_flag.set()
        req_q.put(None)

    threading.Thread(target=reader, name="glance-stdin", daemon=True).start()

    while True:
        req = req_q.get()
        if req is None:
            break
        resp = handle(req)
        _emit(resp)
        if req.get("op") == "quit" and resp.get("ok"):
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
