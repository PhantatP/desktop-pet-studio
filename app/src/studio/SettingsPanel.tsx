import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useRef, useState } from "react";
import { loadSettings, saveSettings, type Settings } from "../settings";

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [autostart, setAutostart] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    void isEnabled().then(setAutostart);
  }, []);

  // save shortly after the last change, so dragging a slider doesn't rebuild the pets on every step
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void saveSettings(settings), 300);
    return () => clearTimeout(timer);
  }, [settings]);

  const set = (change: Partial<Settings>) => setSettings((s) => ({ ...s, ...change }));

  async function toggleAutostart() {
    await (autostart ? disable() : enable());
    setAutostart(await isEnabled());
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">These apply to every pet. Changes take effect right away.</p>
        </div>
      </div>
      <div className="settings">
        <label className="setting">
          <div>
            <strong>Size</strong>
            <span className="muted">How tall the pets are on screen</span>
          </div>
          <input type="range" min={60} max={220} value={settings.size} onChange={(e) => set({ size: +e.target.value })} />
          <output>{settings.size} px</output>
        </label>
        <label className="setting">
          <div>
            <strong>Walking speed</strong>
            <span className="muted">Walking and climbing; steps speed up to match</span>
          </div>
          <input type="range" min={50} max={200} step={5} value={settings.speed} onChange={(e) => set({ speed: +e.target.value })} />
          <output>{settings.speed}%</output>
        </label>
        <label className="setting">
          <div>
            <strong>Climb the screen edges</strong>
            <span className="muted">Pets with climbing frames sometimes climb when they reach an edge</span>
          </div>
          <span className="switch">
            <input type="checkbox" checked={settings.climbing} onChange={(e) => set({ climbing: e.target.checked })} />
            <span className="track" />
          </span>
        </label>
        <label className="setting">
          <div>
            <strong>Start with Windows</strong>
            <span className="muted">Your pets show up as soon as you log in</span>
          </div>
          <span className="switch">
            <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
            <span className="track" />
          </span>
        </label>
      </div>
    </div>
  );
}
