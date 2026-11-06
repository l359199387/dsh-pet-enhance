import ctypes, ctypes.wintypes as w, time

u = ctypes.windll.user32
ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', w.LONG), ('dy', w.LONG), ('mouseData', w.DWORD),
                ('dwFlags', w.DWORD), ('time', w.DWORD), ('dwExtraInfo', ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', w.WORD), ('wScan', w.WORD), ('dwFlags', w.DWORD),
                ('time', w.DWORD), ('dwExtraInfo', ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', w.DWORD), ('wParamL', w.WORD), ('wParamH', w.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ('u',)
    _fields_ = [('type', w.DWORD), ('u', _INPUTUNION)]


class POINT(ctypes.Structure):
    _fields_ = [('x', w.LONG), ('y', w.LONG)]


SW, SH = u.GetSystemMetrics(0), u.GetSystemMetrics(1)


def send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    return u.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))


def move_abs(x, y):
    mi = MOUSEINPUT(int(x * 65535 / (SW - 1)), int(y * 65535 / (SH - 1)), 0, 0x0001 | 0x8000, 0, 0)
    return send(INPUT(type=0, mi=mi))


def key(vk, up):
    ki = KEYBDINPUT(vk, 0, 0x0002 if up else 0, 0, 0)
    return send(INPUT(type=1, ki=ki))


p = POINT(); u.GetCursorPos(ctypes.byref(p))
t = time.time(); move_abs(10, 10)
q = POINT(); u.GetCursorPos(ctypes.byref(q))
print('absolute move ->', q.x, q.y, 'wall', round((time.time() - t) * 1000), 'ms')

state0 = u.GetKeyState(0x14) & 1
key(0x14, False); key(0x14, True); time.sleep(0.05)
state1 = u.GetKeyState(0x14) & 1
key(0x14, False); key(0x14, True)
print('capslock toggled:', state0 != state1, 'restored to', u.GetKeyState(0x14) & 1)

move_abs(p.x, p.y)
z = POINT(); u.GetCursorPos(ctypes.byref(z))
print('cursor restored ->', z.x, z.y)
print('screen', SW, SH)
