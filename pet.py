"""Desktop pet: sprite-sheet characters that walk along the bottom of the screen
and on top of other windows (Windows only).

Left-drag to pick one up, right-click for the menu and settings.
"""

import ctypes
import random
import sys
import time
from ctypes import wintypes
from pathlib import Path

from PySide6.QtCore import QSettings, Qt, QTimer
from PySide6.QtGui import QImage, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QMenu,
    QSlider,
    QWidget,
)

# inside the packaged .exe, bundled files are unpacked to sys._MEIPASS
ASSETS = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "assets"
# character (folder in assets) -> sheet file -> (frames per row, animation name for each row top to bottom)
# None = unused row
CHARACTERS = {
    "girl": {
        "sprites.png": (6, ["idle", None, None, "sit", "cheer", "sleep"]),
        "walk.png": (12, ["walk_right", "walk_left"]),
        "climb.png": (8, ["climb_right", "climb_left"]),
    },
    "boy": {
        "sprites.png": (6, ["idle", None, "sit", "cheer", "sleep"]),
        "walk.png": (12, ["walk_right", "walk_left"]),
        "climb.png": (8, ["climb_right", "climb_left"]),
    },
}
FRAME_SECONDS = {"walk_right": 0.1, "walk_left": 0.1, "cheer": 0.15, "sleep": 0.6, "climb_right": 0.15, "climb_left": 0.15}
# still poses rest on one frame and only flash another (blink, smile) now and then
STILL_FRAME = {"idle": 0, "sit": 2}

TICK_MS = 16  # ~60 updates per second
WALK_SPEED = 2 / 0.03  # pixels per second at 100% speed; preserve the original walking speed
GRAVITY = 1.2 / 0.03**2  # pixels per second squared
MAX_DT = 0.05  # avoid a large jump after the event loop stalls
CLIMB_SPEED = 40  # pixels per second at 100% speed
CLIMB_CHANCE = 1  # chance she climbs a screen edge she walks into, instead of turning around
SNAP = 20  # pixels a surface may rise under her feet and still carry her (moving window, small step up)

APP_NAME = "DesktopPet"
STORE = QSettings(APP_NAME, APP_NAME)  # saved settings, in the registry under HKCU\Software\DesktopPet
RUN = QSettings(r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run", QSettings.NativeFormat)

VISIBLE = bytes(alpha > 40 for alpha in range(256))  # alpha byte -> 1 if the pixel counts as visible

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
for fn in (user32.IsWindowVisible, user32.IsIconic, user32.GetWindowTextLengthW):
    fn.argtypes = [wintypes.HWND]
user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
DWMWA_EXTENDED_FRAME_BOUNDS = 9  # window rect without the invisible resize border
DWMWA_CLOAKED = 14  # hidden by the shell, e.g. on another virtual desktop
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x20  # click-through overlays
WS_EX_TOOLWINDOW = 0x80  # popups, menus, tooltips


def load_settings() -> dict:
    return {
        "characters": [c for c in str(STORE.value("characters", "girl")).split(",") if c in CHARACTERS] or ["girl"],
        "size": int(STORE.value("size", 100)),  # character height in pixels
        "speed": int(STORE.value("speed", 100)),  # percent
        "climbing": STORE.value("climbing", True, type=bool),
    }


def save_settings() -> None:
    STORE.setValue("characters", ",".join(SETTINGS["characters"]))
    for key in ("size", "speed", "climbing"):
        STORE.setValue(key, SETTINGS[key])


SETTINGS = load_settings()


def launch_command() -> str:
    if getattr(sys, "frozen", False):  # the packaged .exe
        return f'"{sys.executable}"'
    return f'"{Path(sys.executable).with_name("pythonw.exe")}" "{Path(__file__).resolve()}"'


def window_rects(skip: int) -> list[tuple[int, int, int, int]]:
    """(left, top, right, bottom) in physical pixels of normal on-screen windows, topmost first."""
    rects = []

    def visit(hwnd, _) -> bool:
        if (
            hwnd == skip
            or not user32.IsWindowVisible(hwnd)
            or user32.IsIconic(hwnd)
            or not user32.GetWindowTextLengthW(hwnd)
            or user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)
        ):
            return True
        cloaked = wintypes.DWORD()
        dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if not cloaked.value:
            r = wintypes.RECT()
            dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r))
            rects.append((r.left, r.top, r.right, r.bottom))
        return True

    user32.EnumWindows(WNDENUMPROC(visit), 0)
    return rects


def spans(flags: list[bool], min_gap: int = 6) -> list[tuple[int, int]]:
    """Inclusive (start, end) runs of true flags, bridging gaps shorter than min_gap."""
    out: list[tuple[int, int]] = []
    for i, on in enumerate(flags):
        if on:
            if out and i - out[-1][1] <= min_gap:
                out[-1] = (out[-1][0], i)
            else:
                out.append((i, i))
    return out


def split(counts: list[int], n: int) -> list[tuple[int, int]]:
    """n (start, end) runs of nonzero counts. Runs come from transparent gaps; where neighbors
    touch, the widest run is cut at its emptiest line until there are n."""
    runs = spans([c > 0 for c in counts])
    while len(runs) < n:
        start, end = max(runs, key=lambda r: r[1] - r[0])
        margin = (end - start) * 15 // 100  # don't cut at the very edge of a run
        cut = min(range(start + margin, end - margin), key=lambda i: counts[i])
        runs.remove((start, end))
        runs += [(start, cut - 1), (cut + 1, end)]
        runs.sort()
    return runs


def slice_sheet(path: Path, columns: int, rows: int, height: int) -> list[list[tuple[QPixmap, float]]]:
    """Find each frame of a rows x columns sheet; return rows of (pixmap, anchor_x).

    Frames are cropped tight, and anchor_x is the character's horizontal center of mass,
    so frames line up on the body instead of on wherever the artist placed them.
    The sheet is scaled so its tallest frame is `height` pixels.
    """
    img = QImage(str(path)).convertToFormat(QImage.Format_ARGB32)
    w, h = img.width(), img.height()
    visible = bytes(img.constBits())[3::4].translate(VISIBLE)  # one byte per pixel: 1 or 0

    sheet = []
    for top, bottom in split([visible[y * w : (y + 1) * w].count(1) for y in range(h)], rows):
        band = visible[top * w : (bottom + 1) * w]
        counts = [band[x::w].count(1) for x in range(w)]  # visible pixels per column
        frames = []
        for left, right in split(counts, columns):
            ys = spans([1 in band[y * w + left : y * w + right + 1] for y in range(bottom - top + 1)], min_gap=h)
            y0, y1 = ys[0][0] + top, ys[-1][1] + top
            center = sum(x * counts[x] for x in range(left, right + 1)) / sum(counts[left : right + 1])
            frames.append((img.copy(left, y0, right - left + 1, y1 - y0 + 1), center - left))
        sheet.append(frames)

    scale = height / max(frame.height() for row in sheet for frame, _ in row)
    return [
        [(QPixmap.fromImage(frame.scaledToHeight(round(frame.height() * scale), Qt.SmoothTransformation)), anchor * scale)
         for frame, anchor in row]
        for row in sheet
    ]


def load_frames(character: str, height: int) -> dict[str, list[tuple[QPixmap, float]]]:
    frames = {}
    for file, (columns, names) in CHARACTERS[character].items():
        rows = slice_sheet(ASSETS / character / file, columns, len(names), height)
        for name, row in zip(names, rows, strict=True):
            if name:
                frames[name] = row
    return frames


class Pet(QWidget):
    def __init__(self, frames: dict[str, list[tuple[QPixmap, float]]], open_settings) -> None:
        super().__init__()
        # Borderless, transparent, always on top, no taskbar button
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_DeleteOnClose)
        self.setToolTip("Drag me around! Right-click for settings.")

        self.frames = frames
        self.open_settings = open_settings
        # big enough for every frame centered on its anchor
        all_frames = [f for row in self.frames.values() for f in row]
        self.resize(
            int(max(2 * max(anchor, pix.width() - anchor) for pix, anchor in all_frames)) + 2,
            max(pix.height() for pix, _ in all_frames),
        )

        self.state = "idle"
        self.direction = 1  # 1 = right, -1 = left
        self.animation_time = 0.0
        self.seconds_left = 0.0  # seconds until the next random decision
        self.still_frame = 0
        self.still_until = 0.0  # animation_time when the still pose changes frame next
        self.fall_speed = 0.0
        self.drag_offset = None

        area = self.screen().availableGeometry()
        self.move(random.randint(area.left(), area.x() + area.width() - self.width()), self.ground_y())
        self.pos_x = float(self.x())
        self.pos_y = float(self.y())
        self.last_tick = time.monotonic()
        self.timer = QTimer(self, timeout=self.tick)
        self.timer.setTimerType(Qt.PreciseTimer)
        self.timer.start(TICK_MS)

    def ground_y(self) -> int:
        area = self.screen().availableGeometry()  # excludes the taskbar
        return area.y() + area.height() - self.height()

    def support_y(self) -> float:
        """Her y when standing on the highest surface at (or SNAP above) her feet: a window's top edge or the floor."""
        hwnd = int(self.winId())
        own = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(own))
        # Win32 gives physical pixels; map them to Qt's logical pixels using our own window as the reference
        dpr = self.devicePixelRatioF()
        ox, oy = self.x() - own.left / dpr, self.y() - own.top / dpr

        cx = self.pos_x + self.width() / 2
        best = self.ground_y()
        above = []  # windows higher in z-order, which can hide part of a lower window's top edge
        for rect in window_rects(hwnd):
            left, top, right, bottom = (rect[0] / dpr + ox, rect[1] / dpr + oy, rect[2] / dpr + ox, rect[3] / dpr + oy)
            y = top - self.height()
            hidden = any(l <= cx <= r and t <= top <= b for l, t, r, b in above)
            if left <= cx <= right and self.pos_y - SNAP <= y < best and not hidden:
                best = y
            above.append((left, top, right, bottom))
        return best

    def set_state(self, state: str, seconds: float = 0) -> None:
        self.state = state
        self.seconds_left = seconds
        self.animation_time = 0.0
        self.still_frame = STILL_FRAME.get(state, 0)
        self.still_until = random.uniform(2, 5)

    def choose_next(self) -> None:
        state = random.choices(["idle", "walk", "sit", "sleep"], weights=[3, 3, 2, 1])[0]
        seconds = {"idle": (2, 5), "walk": (2, 6), "sit": (4, 10), "sleep": (8, 20)}[state]
        if state == "walk":
            self.direction = random.choice([-1, 1])
        self.set_state(state, random.uniform(*seconds))

    def tick(self) -> None:
        now = time.monotonic()
        dt = min(max(now - self.last_tick, 0.0), MAX_DT)
        self.last_tick = now
        self.animation_time += dt
        self.update_still_frame()
        if self.state == "fall":
            ground = self.support_y()
            self.pos_y = min(self.pos_y + self.fall_speed * dt + 0.5 * GRAVITY * dt**2, ground)
            self.fall_speed += GRAVITY * dt
            self.move(round(self.pos_x), round(self.pos_y))
            if self.pos_y >= ground:
                self.fall_speed = 0.0
                self.set_state("idle", 2)
        elif self.state == "climb":
            top = self.screen().availableGeometry().y()
            self.pos_y = max(self.pos_y - CLIMB_SPEED * SETTINGS["speed"] / 100 * dt, top)
            self.move(round(self.pos_x), round(self.pos_y))
            self.seconds_left -= dt
            if self.seconds_left <= 0 or self.pos_y <= top:  # tired, or reached the top: let go
                self.pos_x -= self.direction * self.wall_gap()  # push off the wall back on screen
                self.set_state("fall")
        elif self.state != "drag":
            if self.state == "walk":
                self.step(dt)
            ground = self.support_y()
            if ground - self.pos_y > SNAP:  # surface gone: walked off an edge, or the window moved or closed
                self.set_state("fall")
            else:
                self.pos_y = ground  # ride along with a window that moves a little
                self.move(round(self.pos_x), round(self.pos_y))
                self.seconds_left -= dt
                if self.seconds_left <= 0:
                    self.choose_next()
        self.update()

    def update_still_frame(self) -> None:
        anim = self.animation()
        if anim not in STILL_FRAME or self.animation_time < self.still_until:
            return
        if self.still_frame == STILL_FRAME[anim]:  # resting: flash a random other frame briefly
            others = [i for i in range(len(self.frames[anim])) if i != STILL_FRAME[anim]]
            self.still_frame = random.choice(others)
            self.still_until += random.uniform(0.3, 0.8)
        else:  # back to resting
            self.still_frame = STILL_FRAME[anim]
            self.still_until += random.uniform(2, 5)

    def step(self, dt: float) -> None:
        area = self.screen().availableGeometry()
        left = area.left()
        right = max(left, area.x() + area.width() - self.width())
        self.pos_x += self.direction * WALK_SPEED * SETTINGS["speed"] / 100 * dt
        if self.pos_x <= left or self.pos_x >= right:  # reached a screen edge: climb it or turn around
            self.pos_x = float(min(max(self.pos_x, left), right))
            if SETTINGS["climbing"] and random.random() < CLIMB_CHANCE:
                self.set_state("climb", random.uniform(2, 6))
                self.pos_x += self.direction * self.wall_gap()  # hug the wall
            else:
                self.direction = 1 if self.pos_x <= left else -1
        self.move(round(self.pos_x), round(self.pos_y))

    def wall_gap(self) -> float:
        """Empty pixels between her body and the window edge on the wall side while climbing."""
        frames = self.frames["climb_right" if self.direction > 0 else "climb_left"]
        half = self.width() / 2
        if self.direction > 0:
            return min(half - (pix.width() - anchor) for pix, anchor in frames)
        return min(half - anchor for pix, anchor in frames)

    def animation(self) -> str:
        if self.state == "walk":
            return "walk_right" if self.direction > 0 else "walk_left"
        if self.state in ("drag", "fall"):
            return "cheer"
        if self.state == "climb":  # direction is the wall she walked into
            return "climb_right" if self.direction > 0 else "climb_left"
        return self.state

    def paintEvent(self, event) -> None:
        anim = self.animation()
        frames = self.frames[anim]
        if anim in STILL_FRAME:
            index = self.still_frame
        else:
            seconds = FRAME_SECONDS[anim]
            if anim.startswith(("walk", "climb")):  # faster movement, faster steps
                seconds /= SETTINGS["speed"] / 100
            index = int(self.animation_time / seconds) % len(frames)
        pix, anchor = frames[index]
        # anchor at the window's center, feet on the window's bottom edge
        QPainter(self).drawPixmap(round(self.width() / 2 - anchor), self.height() - pix.height(), pix)

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.LeftButton:
            self.drag_offset = event.globalPosition().toPoint() - self.pos()
            self.set_state("drag")

    def mouseMoveEvent(self, event) -> None:
        if self.state == "drag":
            self.move(event.globalPosition().toPoint() - self.drag_offset)
            self.pos_x = float(self.x())
            self.pos_y = float(self.y())

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.LeftButton and self.state == "drag":
            self.fall_speed = 0.0
            self.set_state("fall")

    def contextMenuEvent(self, event) -> None:
        menu = QMenu(self)
        if self.state == "sleep":
            menu.addAction("Wake up", lambda: self.set_state("idle", 2))
        else:
            menu.addAction("Sleep", lambda: self.set_state("sleep", 60))
        # open after the menu closes, since saving settings may replace this pet
        menu.addAction("Settings…", lambda: QTimer.singleShot(0, self.open_settings))
        menu.addAction("Quit", QApplication.quit)
        menu.exec(event.globalPos())


class SettingsDialog(QDialog):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Desktop Pet Settings")
        self.setWindowFlag(Qt.WindowStaysOnTopHint)
        form = QFormLayout(self)

        self.characters = {}
        row = QHBoxLayout()
        for name in CHARACTERS:
            box = QCheckBox(name.title())
            box.setChecked(name in SETTINGS["characters"])
            box.toggled.connect(self.require_character)
            self.characters[name] = box
            row.addWidget(box)
        form.addRow("Characters", row)

        self.size = self.slider(form, "Size", 60, 200, SETTINGS["size"], " px")
        self.speed = self.slider(form, "Walking speed", 50, 200, SETTINGS["speed"], "%")
        self.climbing = QCheckBox("Climb the screen edges")
        self.climbing.setChecked(SETTINGS["climbing"])
        form.addRow(self.climbing)
        self.startup = QCheckBox("Start with Windows")
        self.startup.setChecked(RUN.contains(APP_NAME))
        form.addRow(self.startup)

        self.buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        self.buttons.accepted.connect(self.accept)
        self.buttons.rejected.connect(self.reject)
        form.addRow(self.buttons)

    def slider(self, form: QFormLayout, label: str, low: int, high: int, value: int, unit: str) -> QSlider:
        slider = QSlider(Qt.Horizontal)
        slider.setRange(low, high)
        slider.setValue(value)
        text = QLabel(f"{value}{unit}")
        text.setMinimumWidth(50)
        slider.valueChanged.connect(lambda v: text.setText(f"{v}{unit}"))
        row = QHBoxLayout()
        row.addWidget(slider)
        row.addWidget(text)
        form.addRow(label, row)
        return slider

    def require_character(self) -> None:
        any_checked = any(box.isChecked() for box in self.characters.values())
        self.buttons.button(QDialogButtonBox.Ok).setEnabled(any_checked)

    def save(self) -> None:
        SETTINGS.update(
            characters=[name for name, box in self.characters.items() if box.isChecked()],
            size=self.size.value(),
            speed=self.speed.value(),
            climbing=self.climbing.isChecked(),
        )
        save_settings()
        if self.startup.isChecked():
            RUN.setValue(APP_NAME, launch_command())
        else:
            RUN.remove(APP_NAME)


class Pets:
    """Keeps one Pet window per character chosen in the settings."""

    def __init__(self) -> None:
        self.pets: dict[str, Pet] = {}
        self.size = SETTINGS["size"]
        self.sync()

    def sync(self) -> None:
        if SETTINGS["size"] != self.size:  # frames are scaled at load time, so rebuild everyone
            for pet in self.pets.values():
                pet.close()
            self.pets.clear()
            self.size = SETTINGS["size"]
        for name in [n for n in self.pets if n not in SETTINGS["characters"]]:
            self.pets.pop(name).close()
        for name in SETTINGS["characters"]:
            if name not in self.pets:
                self.pets[name] = Pet(load_frames(name, self.size), self.open_settings)
                self.pets[name].show()

    def open_settings(self) -> None:
        dialog = SettingsDialog()
        if dialog.exec():
            dialog.save()
            self.sync()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)  # pets get closed and rebuilt when settings change
    if RUN.contains(APP_NAME):  # keep the startup entry pointing here if the .exe was moved
        RUN.setValue(APP_NAME, launch_command())
    pets = Pets()
    sys.exit(app.exec())
