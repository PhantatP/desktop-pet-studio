import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { buildAnimations, missingRequired, type Animations } from "../frames";
import { PET_FILE_FILTER, deletePet, exportPet, importPetFile, loadSheetImage, savePet } from "../library";
import type { PetDef } from "../types";
import { AnimPreview } from "./AnimPreview";

export function Library({ pets, onEdit, onNew }: { pets: PetDef[]; onEdit: (pet: PetDef) => void; onNew: () => void }) {
  async function importFile() {
    const path = await open({ filters: [PET_FILE_FILTER] });
    if (!path) return;
    try {
      await importPetFile(path);
    } catch (e) {
      await message(String(e), { title: "Import pet", kind: "error" });
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My pets</h1>
          <p className="muted">Switch a pet on to let it roam your desktop. Click one there to say hi; right-click for its menu.</p>
        </div>
        <div className="head-actions">
          <button className="ghost" onClick={importFile} title="Add a pet someone sent you (.deskpet file)">
            Import pet
          </button>
          <button className="primary" onClick={onNew}>
            + New pet
          </button>
        </div>
      </div>
      <div className="grid">
        {pets.map((pet) => (
          <PetCard key={pet.id} pet={pet} onEdit={() => onEdit(pet)} />
        ))}
        <button className="card new-card" onClick={onNew}>
          <span className="plus">+</span>
          <span>Make a new pet from a sprite sheet</span>
        </button>
      </div>
    </div>
  );
}

function PetCard({ pet, onEdit }: { pet: PetDef; onEdit: () => void }) {
  const [anims, setAnims] = useState<Animations | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const images = await Promise.all(pet.sheets.map((s) => loadSheetImage(pet, s)));
      const built = await buildAnimations(pet, images, 110, devicePixelRatio);
      if (!cancelled) setAnims(built);
    })();
    return () => {
      cancelled = true;
    };
  }, [pet]);

  const broken = anims !== null && missingRequired(anims) !== null;

  const [exported, setExported] = useState(false);

  async function exportFile() {
    const fileName = pet.name.replace(/[\\/:*?"<>|]/g, "").trim() || "pet"; // characters Windows forbids in file names
    const path = await save({ defaultPath: `${fileName}.deskpet`, filters: [PET_FILE_FILTER] });
    if (!path) return;
    try {
      await exportPet(pet.id, path);
      setExported(true);
      setTimeout(() => setExported(false), 2500);
    } catch (e) {
      await message(`Couldn't export ${pet.name}: ${e}`, { title: "Export pet", kind: "error" });
    }
  }

  async function remove() {
    if (await ask(`Delete ${pet.name}? This can't be undone.`, { title: "Delete pet", kind: "warning" })) {
      await deletePet(pet.id);
    }
  }

  return (
    <div className={`card pet-card ${pet.enabled ? "on" : ""}`}>
      <div className="card-stage">
        <AnimPreview anims={anims} anim="walk_right" width={200} height={130} />
      </div>
      <div className="card-body">
        <h3>{pet.name}</h3>
        <label className={`switch ${broken ? "disabled" : ""}`} title={broken ? "Finish this pet in the editor first" : undefined}>
          <input
            type="checkbox"
            checked={pet.enabled && !broken}
            disabled={broken}
            onChange={() => void savePet({ ...pet, enabled: !pet.enabled })}
          />
          <span className="track" />
          <span>{pet.enabled && !broken ? "On desktop" : "Resting"}</span>
        </label>
      </div>
      <div className="card-actions">
        <button className="ghost" onClick={onEdit}>
          Edit
        </button>
        <button className="ghost" onClick={exportFile} title="Save as a .deskpet file to send to someone">
          {exported ? "Saved!" : "Export"}
        </button>
        <button className="ghost danger" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}
