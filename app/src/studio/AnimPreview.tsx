import { useEffect, useRef } from "react";
import { drawFrame, type Animations } from "../frames";
import { FRAME_SECONDS, type AnimName } from "../types";

/** Plays one animation, feet on the bottom edge, body centered. */
export function AnimPreview({ anims, anim, width, height }: { anims: Animations | null; anim: AnimName; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = devicePixelRatio;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!;
    const start = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const animation = anims?.[anim];
      if (animation) {
        // the first frame's timestamp can be slightly earlier than `start`
        const index = Math.floor(Math.max(0, now - start) / 1000 / FRAME_SECONDS[anim]) % animation.frames.length;
        const frame = animation.frames[index];
        drawFrame(ctx, frame, Math.round(width / 2 - frame.anchor), height - frame.h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [anims, anim, width, height]);

  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}
