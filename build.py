"""Build dist/DesktopPet.exe: one file with Python, Qt and the sprites inside.

Run with: .venv\\Scripts\\python build.py
"""

import subprocess
import sys
from pathlib import Path

from PySide6.QtGui import QImage, QPainter, Qt
from PySide6.QtWidgets import QApplication

import pet

ROOT = Path(__file__).parent
ICON = ROOT / "build" / "icon.ico"

app = QApplication([])

# app icon: the girl's first standing frame, centered on a square transparent canvas
pix, anchor = pet.load_frames("girl", 256)["idle"][0]
icon = QImage(256, 256, QImage.Format_ARGB32)
icon.fill(Qt.transparent)
painter = QPainter(icon)
painter.drawPixmap(round(128 - anchor), 0, pix)
painter.end()
ICON.parent.mkdir(exist_ok=True)
icon.save(str(ICON))

subprocess.run(
    [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--windowed",
        "--name", "DesktopPet", "--icon", str(ICON),
        "--add-data", f"{ROOT / 'assets'};assets",
        str(ROOT / "pet.py"),
    ],
    cwd=ROOT,
    check=True,
)
