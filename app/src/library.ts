// The pet library: pet.json files and sheets in %APPDATA%, plus the built-in pets.
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { detectRows, sliceRow, visibleMask } from "./slicer";
import type { AnimName, PetDef, SheetDef } from "./types";

export async function listPets(): Promise<PetDef[]> {
  const raw = await invoke<string[]>("list_pets");
  return raw.map((json) => JSON.parse(json) as PetDef).sort((a, b) => a.id.localeCompare(b.id));
}

export async function savePet(pet: PetDef): Promise<void> {
  await invoke("save_pet", { id: pet.id, json: JSON.stringify(pet) });
  await emit("library-changed");
}

export async function deletePet(id: string): Promise<void> {
  await invoke("delete_pet", { id });
  await emit("library-changed");
}

/** Copy a picked sheet into the pet's folder; returns its file name there. */
export function importSheet(petId: string, path: string): Promise<string> {
  return invoke<string>("import_sheet", { id: petId, path });
}

/** A .deskpet file holds one pet and its sheets, to send to someone else. */
export const PET_FILE_FILTER = { name: "Desktop Pet", extensions: ["deskpet"] };

export function exportPet(id: string, path: string): Promise<void> {
  return invoke("export_pet", { id, path });
}

export async function importPetFile(path: string): Promise<void> {
  await invoke<string>("import_pet", { path });
  await emit("library-changed");
}

export function newPetId(): string {
  return `pet-${Date.now().toString(36)}`;
}

const imageCache = new Map<string, Promise<ImageBitmap>>();

async function bitmapFrom(bytes: ArrayBuffer | Promise<ArrayBuffer>): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([await bytes]));
}

/** A sheet the user picked but hasn't saved yet. */
export function loadPickedImage(path: string): Promise<ImageBitmap> {
  return bitmapFrom(invoke<ArrayBuffer>("read_file", { path }));
}

export function loadSheetImage(pet: PetDef, sheet: SheetDef): Promise<ImageBitmap> {
  const key = sheet.builtin ? `builtin/${sheet.file}` : `${pet.id}/${sheet.file}`;
  let image = imageCache.get(key);
  if (!image) {
    image = sheet.builtin
      ? fetch(`/builtin/${sheet.file}`).then((r) => bitmapFrom(r.arrayBuffer()))
      : bitmapFrom(invoke<ArrayBuffer>("read_pet_file", { id: pet.id, file: sheet.file }));
    imageCache.set(key, image);
  }
  return image;
}

export function imageData(image: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height);
}

interface BuiltinSheet {
  file: string;
  frames: number;
  rows: (AnimName | null)[];
  rest?: Partial<Record<AnimName, number>>;
}

const BUILTINS: { id: string; name: string; enabled: boolean; sheets: BuiltinSheet[] }[] = [
  {
    id: "builtin-girl",
    name: "Girl",
    enabled: true,
    sheets: [
      { file: "girl/sprites.png", frames: 6, rows: ["idle", null, null, "sit", "cheer", "sleep"], rest: { sit: 2 } },
      { file: "girl/walk.png", frames: 12, rows: ["walk_right", "walk_left"] },
      { file: "girl/climb.png", frames: 8, rows: ["climb_right", "climb_left"] },
    ],
  },
  {
    id: "builtin-boy",
    name: "Boy",
    enabled: false,
    sheets: [
      { file: "boy/sprites.png", frames: 6, rows: ["idle", null, "sit", "cheer", "sleep"] },
      { file: "boy/walk.png", frames: 12, rows: ["walk_right", "walk_left"] },
      { file: "boy/climb.png", frames: 8, rows: ["climb_right", "climb_left"] },
    ],
  },
];

/** On the very first run, add the built-in pets to the library. Returns true on that first run. */
export async function ensureBuiltins(): Promise<boolean> {
  if (localStorage.getItem("seeded")) return false;
  for (const builtin of BUILTINS) {
    const pet: PetDef = { id: builtin.id, name: builtin.name, enabled: builtin.enabled, sheets: [] };
    for (const s of builtin.sheets) {
      const sheet: SheetDef = { file: s.file, builtin: true, rows: [] };
      const data = imageData(await loadSheetImage(pet, sheet));
      const mask = visibleMask(data);
      sheet.rows = detectRows(mask, data.width, data.height, s.rows.length).map(([top, bottom], i) => ({
        top,
        bottom,
        animation: s.rows[i],
        rest: (s.rows[i] && s.rest?.[s.rows[i]!]) ?? 0,
        frames: sliceRow(mask, data.width, top, bottom, s.frames),
      }));
      pet.sheets.push(sheet);
    }
    await savePet(pet);
  }
  localStorage.setItem("seeded", "1");
  return true;
}
