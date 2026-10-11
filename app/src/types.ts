export const ANIMATIONS = [
  "idle",
  "walk_right",
  "walk_left",
  "sit",
  "cheer",
  "sleep",
  "climb_right",
  "climb_left",
] as const;
export type AnimName = (typeof ANIMATIONS)[number];

export const ANIM_LABELS: Record<AnimName, string> = {
  idle: "Standing",
  walk_right: "Walking right",
  walk_left: "Walking left",
  sit: "Sitting",
  cheer: "Happy / picked up",
  sleep: "Sleeping",
  climb_right: "Climbing right wall",
  climb_left: "Climbing left wall",
};

/** Poses that rest on one frame and only flash the others (blinks, smiles) now and then. */
export const STILL_ANIMATIONS: AnimName[] = ["idle", "sit"];

/** Seconds per frame at normal speed; still poses use theirs only in the Studio preview. */
export const FRAME_SECONDS: Record<AnimName, number> = {
  idle: 0.4,
  sit: 0.4,
  walk_right: 0.1,
  walk_left: 0.1,
  cheer: 0.15,
  sleep: 0.6,
  climb_right: 0.15,
  climb_left: 0.15,
};

/** One frame inside a sheet, in sheet pixels. anchor = body's horizontal center, from x. */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: number;
}

export interface RowDef {
  top: number;
  bottom: number;
  animation: AnimName | null;
  /** Resting frame index for still poses. */
  rest: number;
  frames: FrameRect[];
}

export interface SheetDef {
  /** File in the pet's folder, or a path under /builtin/ when builtin is true. */
  file: string;
  builtin?: boolean;
  rows: RowDef[];
}

export interface PetDef {
  id: string;
  name: string;
  enabled: boolean;
  sheets: SheetDef[];
}
