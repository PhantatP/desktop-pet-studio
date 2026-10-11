// Turns a pet definition plus its sheet images into ready-to-draw animations.
import type { AnimName, PetDef } from "./types";

export interface Frame {
  bitmap: ImageBitmap;
  /** Logical pixels. */
  w: number;
  h: number;
  anchor: number;
  /** Draw mirrored (made from the other direction's frames). */
  flip: boolean;
  /** Visibility per bitmap pixel, for clicking only on the character itself. */
  mask: Uint8Array;
}

export interface Animation {
  frames: Frame[];
  rest: number;
}

export type Animations = Partial<Record<AnimName, Animation>>;

export function missingRequired(anims: Animations): string | null {
  if (!anims.idle) return "Choose a row for Standing.";
  if (!anims.walk_right) return "Choose a row for Walking (left or right).";
  return null;
}

/** Scale every sheet so its tallest used frame is `height` logical pixels. */
export async function buildAnimations(
  pet: PetDef,
  images: ImageBitmap[],
  height: number,
  dpr: number,
): Promise<Animations> {
  const anims: Animations = {};
  for (const [i, sheet] of pet.sheets.entries()) {
    const used = sheet.rows.filter((r) => r.animation && r.frames.length);
    if (!used.length) continue;
    const scale = height / Math.max(...used.flatMap((r) => r.frames.map((f) => f.h)));
    for (const row of used) {
      const frames = await Promise.all(
        row.frames.map(async (f): Promise<Frame> => {
          const bitmap = await createImageBitmap(images[i], f.x, f.y, f.w, f.h, {
            resizeWidth: Math.max(1, Math.round(f.w * scale * dpr)),
            resizeHeight: Math.max(1, Math.round(f.h * scale * dpr)),
            resizeQuality: "high",
          });
          return { bitmap, w: f.w * scale, h: f.h * scale, anchor: f.anchor * scale, flip: false, mask: alphaMask(bitmap) };
        }),
      );
      const existing = anims[row.animation!];
      if (existing) existing.frames.push(...frames); // several rows for one animation play in order
      else anims[row.animation!] = { frames, rest: Math.min(row.rest, frames.length - 1) };
    }
  }

  // one direction is enough: mirror it for the other
  const mirror = (a: Animation): Animation => ({
    rest: a.rest,
    frames: a.frames.map((f) => ({ ...f, flip: !f.flip, anchor: f.w - f.anchor })),
  });
  for (const [a, b] of [["walk_right", "walk_left"], ["climb_right", "climb_left"]] as const) {
    if (anims[a] && !anims[b]) anims[b] = mirror(anims[a]!);
    if (anims[b] && !anims[a]) anims[a] = mirror(anims[b]!);
  }
  // missing poses borrow similar ones
  anims.sleep ??= anims.sit ?? anims.idle;
  anims.sit ??= anims.idle;
  anims.cheer ??= anims.idle;
  return anims;
}

function alphaMask(bitmap: ImageBitmap): Uint8Array {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const mask = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 40 ? 1 : 0;
  return mask;
}

/** Is logical point (px, py), relative to the frame's top-left, on a visible pixel? */
export function hitFrame(frame: Frame, px: number, py: number): boolean {
  const { width, height } = frame.bitmap;
  let mx = Math.floor((px / frame.w) * width);
  const my = Math.floor((py / frame.h) * height);
  if (mx < 0 || my < 0 || mx >= width || my >= height) return false;
  if (frame.flip) mx = width - 1 - mx;
  return frame.mask[my * width + mx] === 1;
}

/** Draw a frame with its top-left at logical (x, y); ctx is already scaled to logical pixels. */
export function drawFrame(ctx: CanvasRenderingContext2D, frame: Frame, x: number, y: number) {
  if (!frame.flip) {
    ctx.drawImage(frame.bitmap, x, y, frame.w, frame.h);
    return;
  }
  ctx.save();
  ctx.translate(x + frame.w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(frame.bitmap, 0, 0, frame.w, frame.h);
  ctx.restore();
}
