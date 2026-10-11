import { emit } from "@tauri-apps/api/event";

export interface Settings {
  /** Character height in logical pixels. */
  size: number;
  /** Percent of normal walking/climbing speed. */
  speed: number;
  climbing: boolean;
}

const DEFAULTS: Settings = { size: 100, speed: 100, climbing: true };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  localStorage.setItem("settings", JSON.stringify(settings));
  await emit("settings-changed", settings);
}
