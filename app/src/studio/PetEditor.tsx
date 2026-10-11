import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { buildAnimations, missingRequired, type Animations } from "../frames";
import { imageData, importSheet, loadPickedImage, loadSheetImage, newPetId, savePet } from "../library";
import { detectRows, sliceRow, visibleMask } from "../slicer";
import { ANIMATIONS, ANIM_LABELS, STILL_ANIMATIONS, type AnimName, type PetDef, type RowDef } from "../types";
import { AnimPreview } from "./AnimPreview";
import { FrameThumb } from "./FrameThumb";

interface DraftSheet {
  key: string;
  file: string;
  builtin?: boolean;
  /** Picked from disk and not copied into the library yet. */
  sourcePath?: string;
  image: ImageBitmap;
  mask: Uint8Array;
  rows: RowDef[];
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function rowsFor(sheet: { image: ImageBitmap; mask: Uint8Array }, count?: number, old: RowDef[] = []): RowDef[] {
  const { width, height } = sheet.image;
  return detectRows(sheet.mask, width, height, count).map(([top, bottom], i) => ({
    top,
    bottom,
    animation: old[i]?.animation ?? null,
    rest: 0,
    frames: sliceRow(sheet.mask, width, top, bottom),
  }));
}

/** Where each animation's frames come from, for the checklist next to the preview. */
function sources(assigned: Set<AnimName>): Record<AnimName, { ok: boolean; text: string }> {
  const own = (a: AnimName) => assigned.has(a);
  const from = (a: AnimName, b: AnimName, missing: string) =>
    own(a) ? { ok: true, text: "Has frames" } : own(b) ? { ok: true, text: `Mirrored from ${ANIM_LABELS[b].toLowerCase()}` } : { ok: false, text: missing };
  const borrow = (a: AnimName, fallback: AnimName) =>
    own(a) ? { ok: true, text: "Has frames" } : { ok: true, text: `Uses ${ANIM_LABELS[fallback].toLowerCase()}` };
  return {
    idle: own("idle") ? { ok: true, text: "Has frames" } : { ok: false, text: "Required" },
    walk_right: from("walk_right", "walk_left", "Required (either direction)"),
    walk_left: from("walk_left", "walk_right", "Required (either direction)"),
    sit: borrow("sit", "idle"),
    cheer: borrow("cheer", "idle"),
    sleep: borrow("sleep", own("sit") ? "sit" : "idle"),
    climb_right: from("climb_right", "climb_left", "Off: this pet won't climb"),
    climb_left: from("climb_left", "climb_right", "Off: this pet won't climb"),
  };
}

export function PetEditor({ pet, onClose }: { pet: PetDef | null; onClose: () => void }) {
  const [name, setName] = useState(pet?.name ?? "");
  const [sheets, setSheets] = useState<DraftSheet[]>([]);
  const [loading, setLoading] = useState(pet !== null);
  const [anims, setAnims] = useState<Animations | null>(null);
  const [previewAnim, setPreviewAnim] = useState<AnimName>("idle");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const id = useMemo(() => pet?.id ?? newPetId(), [pet]);

  // load the existing pet's sheets
  useEffect(() => {
    if (!pet) return;
    void (async () => {
      const loaded = await Promise.all(
        pet.sheets.map(async (sheet, i): Promise<DraftSheet> => {
          const image = await loadSheetImage(pet, sheet);
          return { key: `${i}-${sheet.file}`, file: sheet.file, builtin: sheet.builtin, image, mask: visibleMask(imageData(image)), rows: sheet.rows };
        }),
      );
      setSheets(loaded);
      setLoading(false);
    })();
  }, [pet]);

  const draft: PetDef = useMemo(
    () => ({
      id,
      name: name.trim(),
      enabled: pet?.enabled ?? true,
      sheets: sheets.map((s) => ({ file: s.file, builtin: s.builtin, rows: s.rows })),
    }),
    [id, name, pet, sheets],
  );

  // rebuild the preview whenever the rows change
  useEffect(() => {
    let cancelled = false;
    const preview: PetDef = { id, name: "", enabled: true, sheets: sheets.map((s) => ({ file: s.file, rows: s.rows })) };
    void buildAnimations(preview, sheets.map((s) => s.image), 150, devicePixelRatio).then((a) => !cancelled && setAnims(a));
    return () => {
      cancelled = true;
    };
  }, [id, sheets]);

  const assigned = new Set(sheets.flatMap((s) => s.rows.map((r) => r.animation).filter((a): a is AnimName => a !== null)));
  const status = sources(assigned);

  const updateSheet = (key: string, change: (s: DraftSheet) => DraftSheet) =>
    setSheets((all) => all.map((s) => (s.key === key ? change(s) : s)));
  const updateRow = (key: string, index: number, change: (r: RowDef) => RowDef) =>
    updateSheet(key, (s) => ({ ...s, rows: s.rows.map((r, i) => (i === index ? change(r) : r)) }));

  async function addSheets() {
    const picked = await open({ multiple: true, filters: [{ name: "Sprite sheets", extensions: ["png", "webp", "gif"] }] });
    for (const path of picked ?? []) {
      const image = await loadPickedImage(path);
      const sheet = { image, mask: visibleMask(imageData(image)) };
      const draftSheet: DraftSheet = { key: `${Date.now()}-${path}`, file: fileName(path), sourcePath: path, ...sheet, rows: rowsFor(sheet) };
      setSheets((all) => [...all, draftSheet]);
    }
  }

  async function save() {
    const problem = !draft.name ? "Give your pet a name." : anims ? missingRequired(anims) : "Add a sprite sheet.";
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const saved: PetDef = { ...draft, sheets: [] };
      for (const s of sheets) {
        const file = s.sourcePath ? await importSheet(id, s.sourcePath) : s.file;
        saved.sheets.push({ file, builtin: s.builtin, rows: s.rows });
      }
      await savePet(saved);
      onClose();
    } catch (e) {
      setError(`Couldn't save: ${e}`);
      setSaving(false);
    }
  }

  return (
    <div className="editor">
      <header className="editor-bar">
        <button className="ghost" onClick={onClose}>
          ← Back
        </button>
        <h1>{pet ? `Edit ${pet.name}` : "New pet"}</h1>
        <div className="spacer" />
        {error && <span className="error">{error}</span>}
        <button className="primary" onClick={save} disabled={saving || loading}>
          {saving ? "Saving…" : "Save pet"}
        </button>
      </header>

      <div className="editor-body">
        <section className="editor-main">
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              placeholder="e.g. Mali"
              maxLength={24}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
            />
          </label>

          <div className="section-title">
            <h2>Sprite sheets</h2>
            <p>Each row of frames becomes an animation. Pick what each row shows.</p>
          </div>

          {loading && <p className="muted">Loading sheets…</p>}
          {sheets.map((sheet, sheetIndex) => (
            <div className="sheet" key={sheet.key}>
              <div className="sheet-head">
                <strong>Sheet {sheetIndex + 1}</strong>
                <span className="muted">{sheet.builtin ? "built-in" : sheet.file}</span>
                <div className="spacer" />
                <Stepper
                  label="Rows"
                  value={sheet.rows.length}
                  onChange={(n) => updateSheet(sheet.key, (s) => ({ ...s, rows: rowsFor(s, n, s.rows) }))}
                />
                <button className="ghost danger" onClick={() => setSheets((all) => all.filter((s) => s.key !== sheet.key))}>
                  Remove
                </button>
              </div>

              {sheet.rows.map((row, rowIndex) => {
                const still = row.animation !== null && STILL_ANIMATIONS.includes(row.animation);
                return (
                  <div className={`row ${row.animation ? "" : "unused"}`} key={rowIndex}>
                    <div className="row-controls">
                      <select
                        value={row.animation ?? ""}
                        onChange={(e) => {
                          const animation = (e.target.value || null) as AnimName | null;
                          updateRow(sheet.key, rowIndex, (r) => ({ ...r, animation }));
                          if (animation) setPreviewAnim(animation);
                        }}
                      >
                        <option value="">Not used</option>
                        {ANIMATIONS.map((a) => (
                          <option key={a} value={a}>
                            {ANIM_LABELS[a]}
                          </option>
                        ))}
                      </select>
                      <Stepper
                        label="Frames"
                        value={row.frames.length}
                        onChange={(n) =>
                          updateRow(sheet.key, rowIndex, (r) => ({
                            ...r,
                            rest: Math.min(r.rest, n - 1),
                            frames: sliceRow(sheet.mask, sheet.image.width, r.top, r.bottom, n),
                          }))
                        }
                      />
                    </div>
                    <div className="strip" title={still ? "Click a frame to make it the resting pose" : undefined}>
                      {row.frames.map((frame, i) => (
                        <button
                          key={i}
                          className={`thumb ${still && i === row.rest ? "rest" : ""}`}
                          disabled={!still}
                          onClick={() => updateRow(sheet.key, rowIndex, (r) => ({ ...r, rest: i }))}
                        >
                          <FrameThumb image={sheet.image} rect={frame} />
                        </button>
                      ))}
                    </div>
                    {still && <p className="hint">Resting pose is highlighted. Click another frame to change it.</p>}
                  </div>
                );
              })}
            </div>
          ))}

          <button className="add-sheet" onClick={addSheets}>
            <span className="plus">+</span>
            Add sprite sheet
            <small>PNG with transparent background. Rows of frames, any layout.</small>
          </button>
        </section>

        <aside className="editor-side">
          <div className="preview-card">
            <div className="stage">
              <AnimPreview anims={anims} anim={previewAnim} width={260} height={190} />
            </div>
            <p className="preview-label">{ANIM_LABELS[previewAnim]}</p>
          </div>
          <ul className="checklist">
            {ANIMATIONS.map((a) => (
              <li key={a} className={`${previewAnim === a ? "selected" : ""} ${status[a].ok ? "" : "missing"}`}>
                <button onClick={() => setPreviewAnim(a)}>
                  <span className="dot" />
                  <span className="anim-name">{ANIM_LABELS[a]}</span>
                  <span className="anim-source">{status[a].text}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="stepper">
      <span>{label}</span>
      <button onClick={() => value > 1 && onChange(value - 1)} aria-label={`Fewer ${label.toLowerCase()}`}>
        −
      </button>
      <b>{value}</b>
      <button onClick={() => onChange(value + 1)} aria-label={`More ${label.toLowerCase()}`}>
        +
      </button>
    </div>
  );
}
