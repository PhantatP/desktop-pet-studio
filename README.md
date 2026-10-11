# Desktop Pet

Chibi characters that live on your Windows desktop. They walk along the taskbar, stand on top of your windows, climb the screen edges, sit, sleep, and say hi when you click them. A **Studio** window turns any chibi sprite sheet into a new pet.

There are two versions in this repository:

| | Folder | Stack | Status |
|---|---|---|---|
| **Desktop Pet app** | [`app/`](app/) | Tauri 2 (Rust + TypeScript/React) | Current. Has the Studio and a pet library |
| Legacy version | [`pet.py`](pet.py) | Python + PySide6 | Kept for reference. Fixed pets, simple settings dialog |

## Features

- **Pets that move around:** they stand, walk, sit and sleep at random. Idle poses stay still and only blink or smile now and then.
- **Window-aware:** pets walk on the top edges of open windows and fall off the ends. They ride along when a window moves, and ignore edges that other windows cover.
- **Climbing:** a pet that reaches a screen edge sometimes climbs it, then lets go and falls.
- **Mouse interaction:** drag a pet and drop it. Click it to get a speech bubble ("Hi, I'm Girl!"). Right-click it for a menu titled with its name (Sleep / Wake up, Open Studio, Quit).
- **Click-through:** the overlay only catches the mouse over a pet's visible pixels. Everywhere else, clicks go to the windows underneath.
- **Studio:**
  - a pet library with on/off switches
  - a pet editor for importing sprite sheets
  - settings for size, speed, climbing, and starting with Windows
- **Tray icon:** opens the Studio or quits. Launching the app again opens the Studio instead of a second copy.

## Making a pet from a sprite sheet

Open the Studio (tray icon → **Open Studio**) → **New pet**:

1. **Name** the pet.
2. **Add sprite sheet.** Use a PNG (or WebP/GIF) with a **transparent background**, with frames laid out in rows and transparent space between them. You can add several sheets, for example one for poses, one for walking and one for climbing.
3. For each detected row, choose **what it shows** from the dropdown. Use **Not used** for rows to skip.
4. If frames touch each other and get merged (or a stray speck counts as a frame), fix it with the **Frames** −/+ control. Fix merged rows with **Rows** −/+.
5. For Standing and Sitting, **click a thumbnail** to choose the resting frame (the one shown most of the time).
6. Check the animations in the **preview** on the right, then click **Save pet**.

Only **Standing** and **one walking direction** are required. Anything missing is filled in:

| Missing | Uses |
|---|---|
| Walking left / right | the other direction, mirrored |
| Climbing left / right wall | the other direction, mirrored; with neither, the pet doesn't climb |
| Sitting, Happy / picked up | Standing |
| Sleeping | Sitting, or else Standing |

## Building the app

> **The character sprites are not in this repository.** They are private and git-ignored. To build with the built-in Girl and Boy, put their sheets in `app/public/builtin/girl/` and `app/public/builtin/boy/` as `sprites.png`, `walk.png` and `climb.png` (layouts are defined in `BUILTINS` in [`app/src/library.ts`](app/src/library.ts)). Without them, change or empty `BUILTINS` and make pets in the Studio instead.

Requirements (Windows 10/11):

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable, MSVC toolchain)
- Visual Studio Build Tools with the "Desktop development with C++" workload
- WebView2 runtime (included with Windows 10/11)

```powershell
cd app
npm install

# run with live reload of the frontend
npm run tauri dev

# build the single-file release exe
npm run tauri build -- --no-bundle
# -> app/src-tauri/target/release/desktop-pet.exe
```

The release `.exe` is self-contained (about 15 MB) and includes the built-in pets. Running it only requires WebView2. It isn't code-signed, so on first launch Windows SmartScreen shows **More info → Run anyway**.

**Changing the app icon:** run `npx tauri icon path/to/square.png` in `app/`. Then touch `src-tauri/build.rs` before building; otherwise Cargo keeps the old icon embedded in the `.exe`.

## How the app is put together

```
app/
  overlay.html          transparent page the pets are drawn on
  index.html            the Studio window
  public/builtin/       sprite sheets for the built-in Girl and Boy
  src/
    overlay.ts          pet behavior, physics, drawing, mouse handling, right-click menu
    slicer.ts           finds rows and frames in a sheet from its transparent gaps
    frames.ts           builds animations: scaling, mirroring, fallbacks, hit-testing masks
    library.ts          loading/saving pets; built-in pet definitions (BUILTINS)
    settings.ts         size / speed / climbing settings
    types.ts            pet data format, animation names, frame timings
    App.tsx, studio/    the Studio UI (React)
  src-tauri/src/
    lib.rs              overlay + Studio windows, tray icon, pet library commands
    screen.rs           Win32: cursor position and on-screen window rectangles
```

- **One overlay, many pets.** All pets are drawn on a single transparent, always-on-top window that covers the main monitor above the taskbar. About 60 times a second, `overlay.ts` asks Rust (the `scan` command) for the cursor position, and every fourth time also for the other windows' rectangles. It turns mouse input on only while the cursor is over a visible pet pixel.
- **Pet data** is saved in `%APPDATA%\com.desktoppet.app\pets\<id>\`: a `pet.json` (frame rectangles and row assignments) plus copies of the imported sheets. Built-in pets point to sheets bundled in the app. Settings are kept in the app's WebView storage.
- **Tuning:** walking/climbing speed, gravity and climb chance are constants at the top of [`app/src/overlay.ts`](app/src/overlay.ts). Frame timings are `FRAME_SECONDS` in [`app/src/types.ts`](app/src/types.ts).

**Known limits:**
- Pets stay on the main monitor.
- Pets don't slide along with a window dragged sideways.
- Pets only walk on window tops, not their sides.

## Legacy Python version

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install PySide6 pyinstaller

.\.venv\Scripts\python pet.py      # run it
.\.venv\Scripts\python build.py    # build dist/DesktopPet.exe (single file, ~55 MB)
```

Characters and their sheet layouts are set in `CHARACTERS` at the top of [`pet.py`](pet.py). Their sprites go in `assets/girl/` and `assets/boy/`, which aren't in the repository (see above). Settings are saved in the registry under `HKCU\Software\DesktopPet`.
