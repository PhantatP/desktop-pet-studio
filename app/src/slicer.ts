// Finds the frames in a sprite sheet from its transparent gaps.
import type { FrameRect } from "./types";

type Run = [start: number, end: number]; // inclusive

/** 1 per pixel that counts as visible. */
export function visibleMask(image: ImageData): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) mask[i] = image.data[i * 4 + 3] > 40 ? 1 : 0;
  return mask;
}

/** Runs of nonzero counts, bridging gaps shorter than minGap. */
function spans(counts: number[], minGap = 6): Run[] {
  const out: Run[] = [];
  counts.forEach((c, i) => {
    if (c === 0) return;
    const last = out[out.length - 1];
    if (last && i - last[1] <= minGap) last[1] = i;
    else out.push([i, i]);
  });
  return out;
}

/** Exactly n runs when n is given: cut the widest run at its emptiest line where neighbors
 *  touch, or merge the closest runs where there are too many. */
function split(counts: number[], n?: number): Run[] {
  const runs = spans(counts);
  if (n === undefined) return runs;
  while (runs.length < n) {
    const widest = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    const [start, end] = widest;
    const margin = Math.floor((end - start) * 0.15); // don't cut at the very edge of a run
    if (end - start < 4) break;
    let cut = start + margin;
    for (let i = start + margin; i <= end - margin; i++) if (counts[i] < counts[cut]) cut = i;
    runs.splice(runs.indexOf(widest), 1, [start, cut - 1], [cut + 1, end]);
  }
  while (runs.length > n && runs.length > 1) {
    let closest = 0;
    for (let i = 1; i < runs.length - 1; i++) {
      if (runs[i + 1][0] - runs[i][1] < runs[closest + 1][0] - runs[closest][1]) closest = i;
    }
    runs.splice(closest, 2, [runs[closest][0], runs[closest + 1][1]]);
  }
  return runs;
}

/** Vertical [top, bottom] bands of frames; pass n to force that many rows. */
export function detectRows(mask: Uint8Array, width: number, height: number, n?: number): Run[] {
  const counts: number[] = [];
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) c += mask[y * width + x];
    counts.push(c);
  }
  return split(counts, n);
}

/** Frames in one row band; pass n to force that many frames. */
export function sliceRow(mask: Uint8Array, width: number, top: number, bottom: number, n?: number): FrameRect[] {
  const counts = new Array<number>(width).fill(0);
  for (let y = top; y <= bottom; y++) for (let x = 0; x < width; x++) counts[x] += mask[y * width + x];

  return split(counts, n).map(([left, right]) => {
    let y0 = bottom;
    let y1 = top;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (mask[y * width + x]) {
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          break;
        }
      }
    }
    // horizontal center of mass, so frames line up on the body rather than on the artist's grid
    let sum = 0;
    let total = 0;
    for (let x = left; x <= right; x++) {
      sum += x * counts[x];
      total += counts[x];
    }
    return { x: left, y: y0, w: right - left + 1, h: Math.max(1, y1 - y0 + 1), anchor: total ? sum / total - left : (right - left) / 2 };
  });
}
