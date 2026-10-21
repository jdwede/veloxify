// Grenades in the 3D replay: each throw flying along its real path, then the smoke, fire, flash or
// blast where it went off, for as long as it lasts in the game.
import * as THREE from "three";

const S = 0.0254;
const toWorld = (x, y, z, v = new THREE.Vector3()) => v.set(y * S, z * S, x * S);
const TICKS = 64;
// How long each lasts after it goes off (seconds), as in CS2.
const LASTS = { smoke: 18, molotov: 7, flash: 0.25, he: 1.2 };
const SMOKE_GROW_S = 1.4, SMOKE_FADE_S = 2.5;
// A CS2 smoke in the open: about 7 m across and 3.5 m high (meters). Walls hold it in; along a
// corridor it reaches further.
const SMOKE_R = 3.2, SMOKE_H = 3.4, SMOKE_PUFFS = 84;

// The same random layout every time a given grenade is shown.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** A soft round puff (white, fading out at the edge) for fire and blast sprites. */
function puffTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A billowy smoke puff: many soft blobs inside a round falloff, a little darker underneath. */
function cloudTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const r = rng(7);
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 78;
    const x = 128 + Math.cos(a) * d, y = 128 + Math.sin(a) * d, rad = 26 + r() * 30;
    const light = Math.round(225 + 30 * (1 - (y - 50) / 156));
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, `rgba(${light},${light},${light},${0.5 + r() * 0.25})`);
    grad.addColorStop(1, `rgba(${light},${light},${light},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  // Round outline: nothing reaches the square's edge.
  g.globalCompositeOperation = "destination-in";
  const edge = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  edge.addColorStop(0, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = edge;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  /** `room` (optional): { probe(center) → (dir) → meters to the nearest surface that way, or null;
   *  toSun: the sun's direction } — smokes fill the space they're in, lit from the sun's side. */
  constructor(scene, room = null) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.room = room;
    this.puff = puffTexture();
    this.cloud = cloudTexture();
    this.items = [];
  }

  /** This round's throws (from the match details: path, tick, pop_tick, kind). */
  setRound(throws) {
    for (const it of this.items) {
      if (it.obj) this.group.remove(it.obj);
      if (it.cloud) this.group.remove(it.cloud);
    }
    this.items = (throws || []).filter((t) => t.path?.length && t.tick && t.pop_tick).map((t, i) => ({
      t,
      path: t.path.map(([x, y, z]) => toWorld(x, y, z)),
      seed: t.tick * 31 + i,
      obj: null,
      cloud: null,
    }));
    // Smokes are shaped to their surroundings ahead of time, one a moment, so playing doesn't stutter.
    clearTimeout(this.shapeTimer);
    const todo = this.items.filter((it) => it.t.kind === "smoke");
    const next = () => {
      const it = todo.shift();
      if (!it) return;
      if (!it.cloud) it.cloud = this._make(it);
      this.shapeTimer = setTimeout(next, 30);
    };
    this.shapeTimer = setTimeout(next, 200);
  }

  /** Shows what's in the air or burning at this tick. */
  update(tick) {
    for (const it of this.items) {
      const { t } = it;
      const flying = tick >= t.tick && tick < t.pop_tick;
      const after = (tick - t.pop_tick) / TICKS;
      const burning = tick >= t.pop_tick && after < (LASTS[t.kind] ?? 1);
      if (flying) this._fly(it, (tick - t.tick) / Math.max(1, t.pop_tick - t.tick));
      else if (it.obj) it.obj.visible = false;
      if (burning) this._burn(it, after);
      else if (it.cloud) it.cloud.visible = false;
    }
  }

  _fly(it, f) {
    if (!it.obj) {
      it.obj = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshLambertMaterial({ color: it.t.kind === "molotov" ? 0x6b5a3a : 0x3a4038 }));
      this.group.add(it.obj);
    }
    const p = it.path, k = f * (p.length - 1), i = Math.min(p.length - 2, Math.floor(k));
    it.obj.position.lerpVectors(p[i], p[i + 1], k - i);
    it.obj.visible = true;
  }

  _burn(it, s) {
    const kind = it.t.kind;
    if (!it.cloud) it.cloud = this._make(it);
    const c = it.cloud;
    c.visible = true;
    const left = (LASTS[kind] ?? 1) - s;
    if (kind === "smoke") {
      // Blooms out from where it landed over the first second and a half, thins out at the end.
      const grow = Math.min(1, s / SMOKE_GROW_S);
      const ease = 1 - (1 - grow) ** 3;
      const fade = Math.min(1, left / SMOKE_FADE_S);
      for (const sp of c.children) {
        sp.position.copy(sp.userData.home).multiplyScalar(0.25 + 0.75 * ease);
        sp.scale.setScalar(sp.userData.size * (0.35 + 0.65 * ease));
        sp.material.opacity = sp.userData.alpha * fade;
        // Slowly turning, like CS2's churning smoke.
        sp.material.rotation = sp.userData.phase + s * 0.05 * (sp.userData.phase > 3 ? 1 : -1);
      }
    } else if (kind === "molotov") {
      for (const sp of c.children) {
        if (sp.userData.smoke) {
          // Dark smoke rising off the fire, each puff on its own loop.
          const k = (s / 2.4 + sp.userData.phase / 6.3) % 1;
          sp.position.set(sp.userData.home.x * (1 + k), 0.9 + k * 3.2, sp.userData.home.z * (1 + k));
          sp.scale.setScalar(sp.userData.size * (0.6 + k));
          sp.material.opacity = sp.userData.alpha * Math.sin(k * Math.PI) * Math.min(1, left / 1.5) * Math.min(1, s / 0.8);
          continue;
        }
        const flick = 0.75 + 0.25 * Math.sin(s * 9 + sp.userData.phase) * Math.sin(s * 5.3 + sp.userData.phase * 2);
        sp.scale.set(sp.userData.size * 0.7, sp.userData.size * flick * Math.min(1, s / 0.4), 1);
        sp.material.opacity = Math.min(1, left / 1.0) * 0.9;
      }
    } else {
      // Flash and blast: a burst that fades fast.
      const f = 1 - s / (LASTS[kind] ?? 1);
      for (const sp of c.children) {
        sp.scale.setScalar(sp.userData.size * (kind === "he" ? 0.6 + 0.8 * (1 - f) : 1));
        sp.material.opacity = sp.userData.alpha * Math.max(0, f) ** (kind === "he" ? 1.5 : 1);
      }
    }
  }

  _make(it) {
    const g = new THREE.Group();
    const at = it.path[it.path.length - 1];
    g.position.copy(at);
    const r = rng(it.seed);
    const sprite = (color, size, alpha, additive = false, map = this.puff) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, depthWrite: false, opacity: alpha, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
      sp.userData = { size, alpha, phase: r() * 6.3 };
      sp.scale.setScalar(size);
      return sp;
    };
    const kind = it.t.kind;
    if (kind === "smoke") this._smoke(g, at, r, sprite);
    else if (kind === "molotov") {
      for (let i = 0; i < 34; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 1.6;
        const sp = sprite(new THREE.Color().setHSL(0.06 + r() * 0.05, 1, 0.55), 0.6 + r() * 0.5, 0.9, true);
        sp.position.set(Math.cos(a) * d, 0.25 + r() * 0.2, Math.sin(a) * d);
        sp.center.set(0.5, 0.1);
        g.add(sp);
      }
      for (let i = 0; i < 12; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 1.1;
        const shade = 0.06 + r() * 0.05;
        const sp = sprite(new THREE.Color(shade, shade * 0.95, shade * 0.9), 1.4 + r() * 0.9, 0.55, false, this.cloud);
        sp.userData.smoke = true;
        sp.userData.home = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
        g.add(sp);
      }
    } else if (kind === "flash") {
      g.add(sprite(new THREE.Color(1, 1, 0.95), 3.5, 1, true));
    } else {
      g.add(sprite(new THREE.Color(1, 0.75, 0.4), 2.6, 1, true));
      g.add(sprite(new THREE.Color(0.35, 0.33, 0.3), 3.2, 0.6));
    }
    this.group.add(g);
    return g;
  }

  /** A smoke: gray puffs filling the space around where it landed, held in by the walls and
   *  ceiling, brighter on the sun's side and on top. */
  _smoke(g, at, r, sprite) {
    const mid = new THREE.Vector3(0, 1.0, 0);
    const reach = this.room?.probe(mid.clone().add(at)) || null;
    // How open it is around: in a corridor the smoke goes further along it (CS2 fills a volume).
    let open = 1;
    if (reach) {
      let sum = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        sum += Math.min(SMOKE_R, reach(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))) / SMOKE_R;
      }
      open = Math.max(0.35, sum / 16);
    }
    const stretch = Math.min(2, 1 / Math.sqrt(open));
    const toSun = this.room?.toSun || new THREE.Vector3(0.3, 0.9, -0.3);
    const dir = new THREE.Vector3();
    for (let i = 0; i < SMOKE_PUFFS; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r());
      const y = 0.25 + r() * (SMOKE_H - 0.9) * (1 - 0.45 * d * d);
      const home = new THREE.Vector3(Math.cos(a) * d * SMOKE_R * stretch, y, Math.sin(a) * d * SMOKE_R * stretch);
      let size = 2.4 + r() * 1.1;
      if (reach) {
        // Kept inside: the puff's middle stops short of the wall that way, and it shrinks there.
        dir.copy(home).sub(mid);
        const len = dir.length();
        if (len > 0.01) {
          dir.divideScalar(len);
          const room = reach(dir);
          const max = Math.max(0, room - 0.25);
          if (len > max) home.copy(mid).addScaledVector(dir, max);
          size = Math.min(size, Math.max(1.2, 2 * (room - Math.min(len, max)) + 1.2));
        }
      }
      // Light: the sun's side and the top brighter, underneath darker (linear values, before tone mapping).
      const lit = Math.max(0, dir.copy(home).sub(mid).normalize().dot(toSun));
      const shade = 0.27 + 0.1 * (home.y / SMOKE_H) + 0.08 * lit + r() * 0.03;
      const sp = sprite(new THREE.Color(shade, shade, shade * 1.03), size, 0.85 + r() * 0.15, false, this.cloud);
      sp.userData.home = home;
      sp.material.rotation = sp.userData.phase;
      g.add(sp);
    }
  }
}

// ---- gunfire -----------------------------------------------------------------------------------

// How long a muzzle flash shows and the gun kicks back after each shot, and how a tracer flies.
const FLASH_S = 0.05, KICK_S = 0.12, TRACER_S = 0.1, TRACER_SPEED = 260, TRACER_LEN = 3.2;

/** A muzzle flash: a hot core with a few spikes. */
function flareTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.translate(64, 64);
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 40);
  core.addColorStop(0, "rgba(255,255,240,1)");
  core.addColorStop(0.3, "rgba(255,210,120,0.9)");
  core.addColorStop(1, "rgba(255,140,40,0)");
  g.fillStyle = core;
  g.beginPath();
  g.arc(0, 0, 40, 0, Math.PI * 2);
  g.fill();
  for (let k = 0; k < 5; k++) {
    g.rotate((Math.PI * 2) / 5 + (k % 2) * 0.3);
    const s = g.createLinearGradient(0, 0, 62, 0);
    s.addColorStop(0, "rgba(255,230,160,0.95)");
    s.addColorStop(1, "rgba(255,150,50,0)");
    g.fillStyle = s;
    g.beginPath();
    g.moveTo(0, -7);
    g.lineTo(62, 0);
    g.lineTo(0, 7);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Every shot in the demo: the flash at the muzzle, the tracer, and (through the shooter's eyes)
 *  the gun kicking back. */
export class Gunfire {
  constructor(scene, fpScene) {
    this.scene = scene;
    this.tex = flareTexture();
    this.flashes = [];
    this.tracers = [];
    this.fpFlash = this._flash();
    fpScene.add(this.fpFlash);
    this.tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2);
    this.tmp = new THREE.Vector3();
  }

  _flash() {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    sp.visible = false;
    return sp;
  }

  _pooled(list, make) {
    if (this.used[list] < this[list].length) return this[list][this.used[list]++];
    const o = make();
    this.scene.add(o);
    this[list].push(o);
    this.used[list]++;
    return o;
  }

  /** The shots of the last moment at this tick. `who(p)` gives player p's { muzzle, dir } (world)
   *  or null when they can't be seen; `fp` gives the watched player's { index, muzzle (first-person
   *  scene), start (world, where the tracer leaves the screen's gun) } or null. Returns how far the
   *  watched player's gun is kicked back (0 = resting). */
  update(shots, tick, who, fp) {
    this.used = { flashes: 0, tracers: 0 };
    this.fpFlash.visible = false;
    let kick = 0;
    if (shots?.length) {
      const from = tick - TRACER_S * 64 - KICK_S * 64;
      // First shot not older than that (the list is in tick order).
      let lo = 0, hi = shots.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (shots[m][0] < from) lo = m + 1; else hi = m; }
      for (let k = lo; k < shots.length && shots[k][0] <= tick; k++) {
        const [t, p] = shots[k];
        const age = (tick - t) / 64;
        const mine = fp && p === fp.index;
        if (mine && age < KICK_S) kick = Math.max(kick, (1 - age / KICK_S) ** 2);
        const at = mine ? null : who(p);
        if (age < FLASH_S) {
          const spin = ((t * 2654435761) >>> 0) / 4294967296;
          if (mine && fp.muzzle) {
            this.fpFlash.position.copy(fp.muzzle);
            this.fpFlash.scale.setScalar(0.16 + 0.06 * spin);
            this.fpFlash.material.rotation = spin * Math.PI * 2;
            this.fpFlash.material.opacity = 1 - age / FLASH_S;
            this.fpFlash.visible = true;
          } else if (at) {
            const f = this._pooled("flashes", () => this._flash());
            f.position.copy(at.muzzle);
            f.scale.setScalar(0.32 + 0.12 * spin);
            f.material.rotation = spin * Math.PI * 2;
            f.material.opacity = 1 - age / FLASH_S;
            f.visible = true;
          }
        }
        if (age < TRACER_S) {
          const start = mine ? fp.start : at?.muzzle;
          const dir = mine ? fp.dir : at?.dir;
          if (!start || !dir) continue;
          const tr = this._pooled("tracers", () => new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.82, 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
          const d = age * TRACER_SPEED;
          tr.position.copy(start).addScaledVector(dir, d + TRACER_LEN / 2);
          tr.quaternion.setFromUnitVectors(this.tmp.set(0, 0, 1), dir);
          const r = Math.max(0.004, 0.0011 * (d + 2));
          tr.scale.set(r, r, TRACER_LEN);
          tr.material.opacity = 0.75 * (1 - age / TRACER_S);
          tr.visible = true;
        }
      }
    }
    for (let i = this.used.flashes; i < this.flashes.length; i++) this.flashes[i].visible = false;
    for (let i = this.used.tracers; i < this.tracers.length; i++) this.tracers[i].visible = false;
    return kick;
  }
}
