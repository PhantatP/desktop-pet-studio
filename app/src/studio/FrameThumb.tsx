import { useEffect, useRef } from "react";
import type { FrameRect } from "../types";

const HEIGHT = 64;

/** One frame cut from its sheet, as a small thumbnail. */
export function FrameThumb({ image, rect }: { image: ImageBitmap; rect: FrameRect }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(8, Math.round((rect.w * HEIGHT) / rect.h));

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = devicePixelRatio;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  }, [image, rect, width]);

  return <canvas ref={ref} style={{ width, height: HEIGHT, display: "block" }} />;
}
