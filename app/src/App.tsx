import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import "./App.css";
import { listPets } from "./library";
import { Library } from "./studio/Library";
import { PetEditor } from "./studio/PetEditor";
import { SettingsPanel } from "./studio/SettingsPanel";
import type { PetDef } from "./types";

type View = { page: "pets" } | { page: "settings" } | { page: "edit"; pet: PetDef | null };

export default function App() {
  const [view, setView] = useState<View>({ page: "pets" });
  const [pets, setPets] = useState<PetDef[]>([]);

  useEffect(() => {
    const refresh = () => void listPets().then(setPets);
    refresh();
    const unlisten = listen("library-changed", refresh);
    return () => void unlisten.then((stop) => stop());
  }, []);

  if (view.page === "edit") {
    return <PetEditor pet={view.pet} onClose={() => setView({ page: "pets" })} />;
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="paw" aria-hidden />
          <span>
            Desktop Pet
            <small>Studio</small>
          </span>
        </div>
        <button className={view.page === "pets" ? "active" : ""} onClick={() => setView({ page: "pets" })}>
          My pets
        </button>
        <button className={view.page === "settings" ? "active" : ""} onClick={() => setView({ page: "settings" })}>
          Settings
        </button>
        <div className="spacer" />
        <p className="sidebar-tip">Tip: click the Desktop Pet icon in the taskbar tray to open this window again.</p>
      </nav>
      <main>
        {view.page === "pets" ? (
          <Library pets={pets} onEdit={(pet) => setView({ page: "edit", pet })} onNew={() => setView({ page: "edit", pet: null })} />
        ) : (
          <SettingsPanel />
        )}
      </main>
    </div>
  );
}
