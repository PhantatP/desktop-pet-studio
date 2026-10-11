// The pets themselves: behavior, physics, drawing and mouse handling, all inside one
// transparent overlay window. Clicks pass through it except over a pet's visible pixels.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { buildAnimations, drawFrame, hitFrame, missingRequired, type Animations, type Frame } from "./frames";
import { ensureBuiltins, listPets, loadSheetImage } from "./library";
import { loadSettings, type Settings } from "./settings";
import { FRAME_SECONDS, STILL_ANIMATIONS, type AnimName, type PetDef } from "./types";

const WALK_SPEED = 2 / 0.03; // pixels per second at 100% speed
const CLIMB_SPEED = 40; // pixels per second at 100% speed
const GRAVITY = 1.2 / 0.03 ** 2; // pixels per second squared
const MAX_DT = 0.05; // avoid a large jump after a stall
const CLIMB_CHANCE = 0.5; // chance a pet climbs a screen edge it walks into, instead of turning around
const SNAP = 20; // pixels a surface may rise under a pet's feet and still carry it
const WINDOW_SCAN_EVERY = 4; // look up other windows every 4th cursor check

const LINES = [
  (name: string) => `Hi, I'm ${name}!`,
  (name: string) => `${name} is here ♪`,
  (name: string) => `${name} is cheering for you!`,
  () => "Don't forget to drink some water~",
  () => "Time for a little break?",
];

type State = "idle" | "walk" | "sit" | "sleep" | "cheer" | "fall" | "drag" | "climb";
type Rect = [left: number, top: number, right: number, bottom: number];

const rand = (low: number, high: number) => low + Math.random() * (high - low);
const clamp = (v: number, low: number, high: number) => Math.min(Math.max(v, low), high);

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const overlay = getCurrentWindow();

let settings = loadSettings();
let actors: Actor[] = [];
let windows: Rect[] = []; // other windows' rectangles, topmost first
let cursor: [number, number] = [-1, -1];
let interactive = false;
let drag: { actor: Actor; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null = null;

class Actor {
  w = 0;
  h = 0;
  x = 0;
  y = 0;
  state: State = "idle";
  direction = 1; // 1 = right, -1 = left
  animTime = 0;
  secondsLeft = 0; // until the next random decision
  stillFrame = 0;
  stillUntil = 0; // animTime when a still pose changes frame next
  fallSpeed = 0;
  chatIn = rand(30, 90); // seconds until it says something on its own
  bubble = document.createElement("div");
  bubbleUntil = 0;

  constructor(
    public pet: PetDef,
    public anims: Animations,
  ) {
    this.resize();
    this.x = rand(0, Math.max(0, innerWidth - this.w));
    this.y = this.floor();
    this.bubble.className = "bubble";
    document.body.append(this.bubble);
  }

  /** Big enough for every frame centered on its anchor. */
  resize() {
    const frames = Object.values(this.anims).flatMap((a) => a.frames);
    this.w = Math.ceil(Math.max(...frames.map((f) => 2 * Math.max(f.anchor, f.w - f.anchor)))) + 2;
    this.h = Math.max(...frames.map((f) => f.h));
  }

  setAnims(anims: Animations) {
    const bottom = this.y + this.h;
    this.anims = anims;
    this.resize();
    this.y = bottom - this.h;
    this.setState("fall"); // settles onto whatever is below, whatever the new size
  }

  floor() {
    return innerHeight - this.h;
  }

  setState(state: State, seconds = 0) {
    this.state = state;
    this.secondsLeft = seconds;
    this.animTime = 0;
    this.stillFrame = this.anims[this.animation()]?.rest ?? 0;
    this.stillUntil = rand(2, 5);
  }

  animation(): AnimName {
    switch (this.state) {
      case "walk":
        return this.direction > 0 ? "walk_right" : "walk_left";
      case "climb": // direction is the wall it walked into
        return this.direction > 0 ? "climb_right" : "climb_left";
      case "drag":
      case "fall":
      case "cheer":
        return "cheer";
      default:
        return this.state;
    }
  }

  frame(): Frame {
    const name = this.animation();
    const anim = this.anims[name]!;
    if (STILL_ANIMATIONS.includes(name)) return anim.frames[this.stillFrame] ?? anim.frames[0];
    let seconds = FRAME_SECONDS[name];
    if (name.startsWith("walk") || name.startsWith("climb")) seconds /= settings.speed / 100; // faster steps
    return anim.frames[Math.floor(this.animTime / seconds) % anim.frames.length];
  }

  /** Top-left of the current frame: anchor centered, feet on the bottom edge. */
  framePos(frame: Frame): [number, number] {
    return [this.x + this.w / 2 - frame.anchor, this.y + this.h - frame.h];
  }

  hit(px: number, py: number): boolean {
    const frame = this.frame();
    const [fx, fy] = this.framePos(frame);
    return hitFrame(frame, px - fx, py - fy);
  }

  chooseNext() {
    const states: State[] = ["idle", "walk", "sit", "sleep"];
    const weights = [3, 3, 2, 1];
    let pick = Math.random() * 9;
    const state = states.find((_, i) => (pick -= weights[i]) < 0) ?? "idle";
    const seconds = { idle: [2, 5], walk: [2, 6], sit: [4, 10], sleep: [8, 20] }[state as "idle"];
    if (state === "walk") this.direction = Math.random() < 0.5 ? -1 : 1;
    this.setState(state, rand(seconds[0], seconds[1]));
  }

  say(text: string, seconds = 3.5) {
    this.bubble.textContent = text;
    this.bubbleUntil = performance.now() + seconds * 1000;
  }

  /** y when standing on the highest surface at (or SNAP above) its feet: a window's top edge or the floor. */
  supportY(): number {
    const cx = this.x + this.w / 2;
    let best = this.floor();
    const above: Rect[] = []; // windows higher in z-order, which can hide part of a lower window's top edge
    for (const rect of windows) {
      const [left, top, right] = rect;
      const y = top - this.h;
      const hidden = above.some(([l, t, r, b]) => l <= cx && cx <= r && t <= top && top <= b);
      if (left <= cx && cx <= right && this.y - SNAP <= y && y < best && !hidden) best = y;
      above.push(rect);
    }
    return best;
  }

  /** Empty space between its body and the box edge on the wall side while climbing. */
  wallGap(): number {
    const frames = this.anims[this.direction > 0 ? "climb_right" : "climb_left"]!.frames;
    const half = this.w / 2;
    return Math.min(...frames.map((f) => (this.direction > 0 ? half - (f.w - f.anchor) : half - f.anchor)));
  }

  tick(dt: number) {
    this.animTime += dt;
    this.updateStillFrame();
    this.chat(dt);
    if (this.state === "drag") return;
    if (this.state === "fall") {
      const ground = this.supportY();
      this.y = Math.min(this.y + this.fallSpeed * dt + 0.5 * GRAVITY * dt * dt, ground);
      this.fallSpeed += GRAVITY * dt;
      if (this.y >= ground) {
        this.fallSpeed = 0;
        this.setState("idle", 2);
      }
      return;
    }
    if (this.state === "climb") {
      this.y = Math.max(this.y - CLIMB_SPEED * (settings.speed / 100) * dt, 0);
      this.secondsLeft -= dt;
      if (this.secondsLeft <= 0 || this.y <= 0) {
        // tired, or reached the top: push off the wall and let go
        this.x -= this.direction * this.wallGap();
        this.setState("fall");
      }
      return;
    }
    if (this.state === "walk" && this.step(dt)) return; // started climbing
    const ground = this.supportY();
    if (ground - this.y > SNAP) {
      this.setState("fall"); // walked off an edge, or the window moved or closed
      return;
    }
    this.y = ground; // ride along with a window that moves a little
    this.secondsLeft -= dt;
    if (this.secondsLeft <= 0) this.chooseNext();
  }

  /** Walk a bit; returns true if it reached a screen edge and started climbing it. */
  step(dt: number): boolean {
    const right = Math.max(0, innerWidth - this.w);
    this.x += this.direction * WALK_SPEED * (settings.speed / 100) * dt;
    if (this.x > 0 && this.x < right) return false;
    // reached a screen edge: climb it or turn around
    this.x = clamp(this.x, 0, right);
    if (settings.climbing && this.anims.climb_right && Math.random() < CLIMB_CHANCE) {
      this.setState("climb", rand(2, 6));
      this.x += this.direction * this.wallGap(); // hug the wall
      return true;
    }
    this.direction = this.x <= 0 ? 1 : -1;
    return false;
  }

  updateStillFrame() {
    const name = this.animation();
    const anim = this.anims[name]!;
    if (!STILL_ANIMATIONS.includes(name) || anim.frames.length < 2 || this.animTime < this.stillUntil) return;
    if (this.stillFrame === anim.rest) {
      // resting: flash a random other frame briefly
      const others = anim.frames.map((_, i) => i).filter((i) => i !== anim.rest);
      this.stillFrame = others[Math.floor(Math.random() * others.length)];
      this.stillUntil += rand(0.3, 0.8);
    } else {
      this.stillFrame = anim.rest;
      this.stillUntil += rand(2, 5);
    }
  }

  chat(dt: number) {
    this.chatIn -= dt;
    if (this.chatIn > 0) return;
    this.chatIn = rand(60, 180);
    if (this.state === "idle" || this.state === "walk" || this.state === "sit") {
      this.say(LINES[Math.floor(Math.random() * LINES.length)](this.pet.name));
    }
  }

  draw(dpr: number) {
    const frame = this.frame();
    const [fx, fy] = this.framePos(frame);
    drawFrame(ctx, frame, Math.round(fx * dpr) / dpr, Math.round(fy * dpr) / dpr); // whole device pixels: crisp
    const showBubble = performance.now() < this.bubbleUntil;
    this.bubble.classList.toggle("visible", showBubble);
    if (showBubble) {
      this.bubble.style.left = `${clamp(this.x + this.w / 2, 80, innerWidth - 80)}px`;
      this.bubble.style.top = `${fy}px`;
    }
  }
}

function actorAt(x: number, y: number): Actor | undefined {
  return [...actors].reverse().find((a) => a.hit(x, y)); // last drawn is on top
}

/** Accept clicks only while the cursor is over a pet. */
function updateInteractive() {
  const over = drag !== null || actorAt(cursor[0], cursor[1]) !== undefined;
  if (over !== interactive) {
    interactive = over;
    void overlay.setIgnoreCursorEvents(!over);
  }
}

let scanning = false;
let scans = 0;
let last = performance.now();

function loop(now: number) {
  const dt = clamp((now - last) / 1000, 0, MAX_DT);
  last = now;
  if (!scanning) {
    scanning = true;
    invoke<{ cursor: [number, number]; windows: Rect[] | null }>("scan", { windows: scans++ % WINDOW_SCAN_EVERY === 0 })
      .then((scan) => {
        cursor = scan.cursor;
        if (scan.windows) windows = scan.windows;
        updateInteractive();
      })
      .finally(() => (scanning = false));
  }
  for (const actor of actors) actor.tick(dt);

  const dpr = devicePixelRatio;
  const width = Math.round(innerWidth * dpr);
  const height = Math.round(innerHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const actor of actors) actor.draw(dpr);
  requestAnimationFrame(loop);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const actor = actorAt(e.clientX, e.clientY);
  if (!actor) return;
  drag = { actor, dx: e.clientX - actor.x, dy: e.clientY - actor.y, startX: e.clientX, startY: e.clientY, moved: false };
  actor.setState("drag");
  canvas.setPointerCapture(e.pointerId);
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.moved ||= Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4;
  if (!drag.moved) return;
  drag.actor.x = e.clientX - drag.dx;
  drag.actor.y = e.clientY - drag.dy;
});

canvas.addEventListener("pointerup", () => {
  if (!drag) return;
  const { actor, moved } = drag;
  drag = null;
  canvas.style.cursor = "";
  if (moved) {
    actor.x = clamp(actor.x, 0, Math.max(0, innerWidth - actor.w));
    actor.fallSpeed = 0;
    actor.setState("fall");
  } else {
    // a click: say hello
    actor.setState("cheer", 1.6);
    actor.say(`Hi, I'm ${actor.pet.name}!`);
  }
});

document.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("contextmenu", async (e) => {
  const actor = actorAt(e.clientX, e.clientY);
  if (!actor) return;
  const sleeping = actor.state === "sleep";
  const menu = await Menu.new({
    items: [
      { text: actor.pet.name, enabled: false },
      { item: "Separator" },
      {
        text: sleeping ? "Wake up" : "Sleep",
        action: () => (sleeping ? actor.setState("idle", 2) : actor.setState("sleep", 60)),
      },
      { text: "Open Studio", action: () => void invoke("open_studio") },
      { item: "Separator" },
      { text: "Quit", action: () => void invoke("quit") },
    ],
  });
  await menu.popup();
});

/** Rebuild the pets from the library, keeping the ones that already exist where they are. */
async function reload() {
  const next: Actor[] = [];
  for (const pet of await listPets()) {
    if (!pet.enabled) continue;
    const images = await Promise.all(pet.sheets.map((sheet) => loadSheetImage(pet, sheet)));
    const anims = await buildAnimations(pet, images, settings.size, devicePixelRatio);
    if (missingRequired(anims)) continue;
    const existing = actors.find((a) => a.pet.id === pet.id);
    if (existing) {
      existing.pet = pet;
      existing.setAnims(anims);
      next.push(existing);
    } else {
      next.push(new Actor(pet, anims));
    }
  }
  for (const actor of actors) if (!next.includes(actor)) actor.bubble.remove();
  actors = next;
}

let reloading = Promise.resolve();
function requestReload() {
  reloading = reloading.then(reload, reload); // one at a time, in order
}

async function main() {
  void listen("library-changed", requestReload);
  void listen<Settings>("settings-changed", (e) => {
    const sizeChanged = e.payload.size !== settings.size;
    settings = e.payload;
    if (sizeChanged) requestReload();
  });
  const firstRun = await ensureBuiltins();
  requestReload();
  if (firstRun) void invoke("open_studio"); // welcome the new owner
  requestAnimationFrame(loop);
}

void main();
