"""Draws the built-in Cat's sprite sheets for the Store version of the app (no real people).

Run with: .venv\\Scripts\\python tools\\make_cat_sheet.py
Writes app/public-store/builtin/cat/sprites.png (rows: standing, walking right, sitting,
happy, sleeping) and climb.png (one row: climbing the right wall). Every frame is drawn
facing right in its own 120x120 cell; the app mirrors frames for the other direction.
"""

import math
from pathlib import Path

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QGuiApplication, QImage, QPainter, QPainterPath, QPen, QPolygonF

CELL = 120
FUR = QColor(240, 160, 70)
OUTLINE = QColor(140, 80, 30)
OUT = Path(__file__).resolve().parent.parent / "app" / "public-store" / "builtin" / "cat"


def draw_cat(p: QPainter, pose: str, frame: int) -> None:
    """One cat facing right in a CELL x CELL box. pose: idle, walk, sit, happy, sleep."""
    lying = pose == "sleep"
    sitting = pose == "sit"
    hy = {"sleep": 86, "sit": 52, "happy": 50}.get(pose, 62)  # head center y
    lift = -8 if pose == "happy" else 0  # happy: a little hop

    # tail: sways, or curls on the ground while asleep
    if lying:
        tail = QPainterPath(QPointF(28, 96))
        tail.cubicTo(8, 96, 6, 110, 24, 110)
    else:
        sway = math.sin(frame / 6 * 2 * math.pi) * 6
        base_y = 98 if sitting else 82 + lift
        tail = QPainterPath(QPointF(30, base_y))
        tail.cubicTo(10, base_y, 8 + sway, base_y - 22, 14 + sway, base_y - 42)
    p.setBrush(Qt.NoBrush)
    p.setPen(QPen(OUTLINE, 10, Qt.SolidLine, Qt.RoundCap))
    p.drawPath(tail)
    p.setPen(QPen(FUR, 6, Qt.SolidLine, Qt.RoundCap))
    p.drawPath(tail)

    p.setPen(QPen(OUTLINE, 2))
    p.setBrush(FUR)

    # legs: walking swings alternate pairs; happy dangles them; sitting tucks the back ones
    if pose in ("idle", "walk", "happy"):
        step = frame % 2
        length = 26 if pose == "happy" else 20
        for x, phase in ((34, 0), (46, 1), (66, 1), (78, 0)):
            dx = (4 if step == phase else -4) if pose == "walk" else 0
            p.drawRoundedRect(QRectF(x + dx, 90 + lift, 9, length), 4, 4)
    elif sitting:
        for x in (66, 78):
            p.drawRoundedRect(QRectF(x, 84, 9, 26), 4, 4)

    # body
    if lying:
        p.drawEllipse(QRectF(22, 78, 66, 30))
    elif sitting:
        p.drawEllipse(QRectF(30, 62, 50, 50))
    else:
        p.drawEllipse(QRectF(25, 64 + lift, 60, 36))

    # ears, then the head over their base
    p.drawPolygon(QPolygonF([QPointF(74, hy - 8), QPointF(76, hy - 28), QPointF(88, hy - 16)]))
    p.drawPolygon(QPolygonF([QPointF(92, hy - 16), QPointF(102, hy - 28), QPointF(104, hy - 6)]))
    p.drawEllipse(QPointF(88, hy), 20, 18)

    # eyes: closed asleep or on the blink frame, happy arcs, otherwise round
    blink = pose in ("idle", "sit") and frame == 3
    for ex in (82, 96):
        if lying or blink:
            p.drawLine(QPointF(ex - 3, hy - 2), QPointF(ex + 3, hy - 2))
        elif pose == "happy":
            p.setBrush(Qt.NoBrush)
            p.drawArc(QRectF(ex - 4, hy - 4, 8, 8), 0, 180 * 16)
            p.setBrush(FUR)
        else:
            p.setBrush(Qt.black)
            p.drawEllipse(QPointF(ex, hy - 2), 2.5, 3.5)
            p.setBrush(FUR)

    # nose and whiskers
    p.setBrush(QColor(240, 120, 140))
    p.drawPolygon(QPolygonF([QPointF(87, hy + 4), QPointF(91, hy + 4), QPointF(89, hy + 7)]))
    p.setPen(QPen(OUTLINE, 1))
    for dy in (4, 8):
        p.drawLine(QPointF(98, hy + 5), QPointF(112, hy + dy))
        p.drawLine(QPointF(80, hy + 5), QPointF(66, hy + dy))

    if lying and frame % 3 != 0:  # floating z's on most sleep frames
        p.setPen(OUTLINE)
        p.setFont(QFont("Segoe UI", 12, QFont.Bold))
        bob = frame % 3 * 4
        p.drawText(QPointF(70, 60 - bob), "z")
        p.drawText(QPointF(82, 50 - bob), "Z")


def sheet(rows: list[tuple[str, int]], rotate: float = 0) -> QImage:
    width = max(n for _, n in rows) * CELL
    img = QImage(width, len(rows) * CELL, QImage.Format_ARGB32)
    img.fill(Qt.transparent)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    for r, (pose, frames) in enumerate(rows):
        for f in range(frames):
            p.save()
            p.translate(f * CELL + CELL / 2, r * CELL + CELL / 2)
            p.rotate(rotate)
            p.translate(-CELL / 2, -CELL / 2)
            draw_cat(p, pose, f)
            p.restore()
    p.end()
    return img


if __name__ == "__main__":
    app = QGuiApplication([])
    OUT.mkdir(parents=True, exist_ok=True)
    sheet([("idle", 6), ("walk", 6), ("sit", 6), ("happy", 6), ("sleep", 6)]).save(str(OUT / "sprites.png"))
    # climbing the right wall: the walking cat turned to face up, feet against the wall
    sheet([("walk", 6)], rotate=-90).save(str(OUT / "climb.png"))
    print("wrote", OUT)
