// The 3D replay: CS2's own map (prepared once from the user's CS2 install) and every player's
// movement and aim from the demo, 32 times a second. One viewer is kept for the whole app, so the
// map stays loaded when you switch rounds or tabs.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { Models, Body, setOf } from "./players3d.js";
import { Effects, Gunfire } from "./effects3d.js";

// Game units are inches, the map export is in meters with its axes as (y, z, x).
const S = 0.0254;
const toWorld = (x, y, z, v = new THREE.Vector3()) => v.set(y * S, z * S, x * S);
const SIDE_COLOR = { CT: 0x5b8fd9, T: 0xe0a73a };
// Eye height standing and how much crouching takes off (game units).
const EYE = 64, CROUCH_DROP = 18;
// CS2's default view: 90° across at 4:3, which is 73.74° up and down on any screen.
const VFOV = 73.74;
// Scoped in with a sniper rifle (first zoom): 40° across at 4:3.
const SCOPE_VFOV = 2 * Math.atan(Math.tan((40 / 2) * Math.PI / 180) * 0.75) * 180 / Math.PI;
const SNIPERS = /^(awp|ssg08|scar20|g3sg1)$/;
// CS2's first-person gun and arms: 68° across at 4:3.
const FP_VFOV = 2 * Math.atan(Math.tan((68 / 2) * Math.PI / 180) * 0.75) * 180 / Math.PI;
// CS2's picture: ACES's filmic curve, but keeping colors' hue in bright light (plain ACES turns
// orange lamp light on Mirage's gray-green plaster yellow-green), a touch warmer overall.
const TONE = { keepHue: 0.7, warm: [1.045, 1.005, 0.975] };
function cs2ToneMapping(tone) {
  const w = tone.warm.map((n) => n.toFixed(3)).join(", ");
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    /vec3 CustomToneMapping\( vec3 color \) \{[^}]*\}/,
    `vec3 CustomToneMapping( vec3 color ) {
      vec3 aces = ACESFilmicToneMapping( color );
      float m = max( max( color.r, color.g ), color.b );
      vec3 hue = color * ( ACESFilmicToneMapping( vec3( m ) ).g / max( m, 1e-5 ) );
      return saturate( mix( aces, hue, ${tone.keepHue.toFixed(3)} ) * vec3( ${w} ) );
    }`,
  );
}
// The first-person gun: metal catching the sky and ground (CS2's guns shine; the models come
// with their colors only, so one sheen for all).
const FP_METAL = { metalness: 0.35, roughness: 0.55, env: 0.8, sky: [2.6, 4.2] };
// Lighting, matched against CS2's own picture of the same spot on Mirage.
const LIGHT = { sun: 6.0, sky: 0.3, baked: 0.8, exposure: 1.0, props: 0.3 };

/** A blended surface: the second layer painted over the first by the vertex blend weight, the
 *  edge shaped by the blend pattern (CS2's "fancy blending"). */
function blendLayers(mat, layer2, pattern) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.map2 = { value: layer2 };
    if (pattern) sh.uniforms.blendMod = { value: pattern };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
attribute vec4 blendw;
varying float vBlend;`)
      .replace("#include <uv_vertex>", `#include <uv_vertex>
vBlend = blendw.x;`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
varying float vBlend;
uniform sampler2D map2;
${pattern ? "uniform sampler2D blendMod;" : ""}`)
      .replace("#include <map_fragment>", `
        #ifdef USE_MAP
          vec4 c1 = texture2D(map, vMapUv);
          vec4 c2 = texture2D(map2, vMapUv);
          ${pattern ? "float bm = texture2D(blendMod, vMapUv).r; float bt = smoothstep(bm - 0.25, bm + 0.25, vBlend);" : "float bt = vBlend;"}
          diffuseColor *= mix(c1, c2, bt);
        #endif`);
  };
  mat.customProgramCacheKey = () => (pattern ? "vx-blend-p" : "vx-blend");
}

/** A match's 3D replay data (`matches/<id>.r3d.gz`): header plus one Int16Array per round. */
export async function loadTrack(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`3D replay data: ${res.status}`);
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "VR3D") throw new Error("not a 3D replay file");
  const dv = new DataView(buf);
  const hl = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hl)));
  const P = header.players.length;
  // Version 1 had 7 numbers a sample (no flags) and no shots.
  const stride = header.stride || 7;
  let off = 12 + hl;
  const rounds = header.rounds.map((r) => {
    const bytes = P * r.n * stride * 2;
    // Copied out so the numbers are 2-byte aligned. Sample k of player p: data[(p * n + k) * stride + c].
    const data = new Int16Array(buf.slice(off, off + bytes));
    off += bytes;
    return { ...r, data, stride, shots: r.shots || [], reloads: r.reloads || [] };
  });
  // Then (version 2) the HUD's numbers, 8 a second: ammo in the gun, ammo left, armor, helmet, money.
  const hs = header.hud_stride || 0;
  if (hs) {
    for (const r of rounds) {
      const bytes = P * r.hud_n * hs * 2;
      r.hud = new Int16Array(buf.slice(off, off + bytes));
      off += bytes;
    }
  }
  return { header, rounds };
}

/** Player p's HUD numbers in round r at this tick (null without them): ammo, armor, helmet, money. */
export function hudAt(track, r, p, tick) {
  const hs = track.header.hud_stride, step = track.header.hud_step;
  if (!hs || !r.hud) return null;
  const k = Math.max(0, Math.min(r.hud_n - 1, Math.floor((tick - r.start) / step)));
  const a = (p * r.hud_n + k) * hs;
  return { ammo: r.hud[a], armor: r.hud[a + 2], helmet: r.hud[a + 3] > 0, money: r.hud[a + 4] };
}

const lerpAngle = (a, b, t) => a + ((((b - a + 540) % 360) + 360) % 360 - 180) * t;

/** The last sample at which player p is alive in round r (-1 if never), kept on the round. */
function lastAlive(r, p) {
  const k = r.stride || 7, n = r.n;
  r.lastAlive ||= [];
  if (r.lastAlive[p] === undefined) {
    let i = n - 1;
    while (i >= 0 && r.data[(p * n + i) * k + 6] <= 0) i--;
    r.lastAlive[p] = i;
  }
  return r.lastAlive[p];
}
// A killed player's body falls over in this long, then lies there for the rest of the round.
const FALL_S = 0.45;

/** Player p in round r at fractional sample f: position, view, crouch, health, scoped in. */
export function sampleAt(r, p, f, out = {}) {
  const n = r.n, D = r.data, k = r.stride || 7;
  const i0 = Math.max(0, Math.min(n - 1, Math.floor(f))), i1 = Math.min(n - 1, i0 + 1);
  let t = Math.max(0, Math.min(1, f - i0));
  const a = (p * n + i0) * k, b = (p * n + i1) * k;
  // Spawning, dying or a jump across the map: no blending between the two.
  if (D[a + 6] <= 0 || D[b + 6] <= 0 || Math.abs(D[b] - D[a]) + Math.abs(D[b + 1] - D[a + 1]) > 160) t = t < 0.5 ? 0 : 1;
  out.x = D[a] + (D[b] - D[a]) * t;
  out.y = D[a + 1] + (D[b + 1] - D[a + 1]) * t;
  out.z = D[a + 2] + (D[b + 2] - D[a + 2]) * t;
  out.yaw = lerpAngle(D[a + 3] / 50, D[b + 3] / 50, t);
  out.pitch = (D[a + 4] + (D[b + 4] - D[a + 4]) * t) / 100;
  out.duck = (D[a + 5] + (D[b + 5] - D[a + 5]) * t) / 1000;
  out.hp = t < 0.5 ? D[a + 6] : D[b + 6];
  out.scoped = k > 7 && ((t < 0.5 ? D[a + 7] : D[b + 7]) & 1) === 1;
  return out;
}

/** Where a view with this yaw and pitch (game degrees, pitch down = positive) looks, in world space. */
function viewDir(yaw, pitch, v = new THREE.Vector3()) {
  const cy = Math.cos(yaw * Math.PI / 180), sy = Math.sin(yaw * Math.PI / 180);
  const cp = Math.cos(pitch * Math.PI / 180), sp = Math.sin(pitch * Math.PI / 180);
  return v.set(cp * sy, -sp, cp * cy);
}

function makeFigure(color) {
  const mat = new THREE.MeshLambertMaterial({ color });
  const dark = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.92, 4, 12), mat);
  body.position.y = 0.73;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), mat);
  head.position.y = 1.64;
  const aim = new THREE.Group();
  aim.position.set(0.14, 1.4, 0.05);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.62), dark);
  gun.position.z = 0.3;
  aim.add(gun);
  const shape = new THREE.Group();
  shape.add(body, head, aim);
  g.add(shape);
  g.userData = { aim, mat, shape };
  return g;
}

class Viewer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "v3d-canvas";
    this.canvas.tabIndex = 0;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    cs2ToneMapping(window.__vxTone || TONE);
    this.renderer.toneMapping = THREE.CustomToneMapping;
    this.renderer.toneMappingExposure = LIGHT.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The map doesn't move: its shadows are drawn again only when the view moves somewhere else.
    this.renderer.shadowMap.autoUpdate = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#9ec3e6");
    this.camera = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.05, 2000);
    // The first-person arms and gun: their own scene, drawn over the world (they never go into walls).
    this.fpScene = new THREE.Scene();
    this.fpCamera = new THREE.PerspectiveCamera(FP_VFOV, 16 / 9, 0.01, 10);
    this.fpSun = new THREE.DirectionalLight(0xffe0b0, LIGHT.sun);
    this.fpSky = new THREE.HemisphereLight(0xcfd8e6, 0x8a7560, 0.6);
    this.fpScene.add(this.fpCamera, this.fpSun, this.fpSky);
    this.fp = null;
    const viewer = this;
    this.effects = new Effects(this.scene, { probe: (at) => this._probe(at), get toSun() { return viewer.toSun; } });
    this.fire = new Gunfire(this.scene, this.fpScene);
    this.ray = new THREE.Raycaster();
    this.renderer.autoClear = false;
    this.sun = new THREE.DirectionalLight(0xffe0b0, LIGHT.sun);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 400 });
    this.toSun = new THREE.Vector3(0.335, 0.866, -0.372).normalize();
    this.shadowAt = null;
    this.scene.add(this.sun, this.sun.target, new THREE.HemisphereLight(0xcfd8e6, 0x8a7560, LIGHT.sky));
    this.map = null;
    this.mapRoot = null;
    this.figures = [];
    this.free = { pos: new THREE.Vector3(), yaw: 0, pitch: 20, keys: new Set() };
    this.pov = null;
    this.raf = 0;
    this.tmp = {};
    this._bindInput();
  }

  /** Loads the map (once; the same map stays). `urlOf(name)` gives a file's URL in its folder. */
  async loadMap(map, urlOf, onProgress) {
    if (this.map === map && this.mapRoot) return;
    if (this.mapRoot) {
      this.scene.remove(this.mapRoot);
      this.mapRoot.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); }); } });
      this.mapRoot = null;
    }
    this.map = map;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => (u.startsWith("veloxify-map:") ? urlOf(u.slice("veloxify-map:".length)) : u));
    manager.onProgress = (_, done, total) => onProgress?.(done / Math.max(1, total));
    const gl = new GLTFLoader(manager);
    gl.setResourcePath("veloxify-map:");
    const [gltf, baked] = await Promise.all([gl.loadAsync(urlOf("world.glb")), new RGBELoader(manager).loadAsync(urlOf("irradiance.hdr"))]);
    baked.flipY = false;
    baked.channel = 1;
    baked.colorSpace = THREE.NoColorSpace;
    baked.generateMipmaps = false;
    baked.minFilter = baked.magFilter = THREE.LinearFilter;
    baked.needsUpdate = true;
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // Blended surfaces (paint over plaster, sand over tiles): their second layer and blend pattern.
    const layerTex = new Map();
    const wanted = new Set();
    root.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        const tp = m.userData?.vmat?.TextureParams;
        if (m.userData?.vmat?.IntParams?.F_LAYERS && tp) for (const k of ["g_tLayer2Color", "g_tBlendModulation"]) if (tp[k]) wanted.add(tp[k]);
      }
    });
    const texLoader = new THREE.TextureLoader(manager);
    await Promise.all([...wanted].map(async (vtex) => {
      const png = vtex.split("/").pop().replace(/\.vtex$/, ".png");
      try {
        const t = await texLoader.loadAsync(`veloxify-map:${png}`);
        t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = /Layer2Color/.test(vtex) || !/blend/i.test(png) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        layerTex.set(vtex, t);
      } catch (e) { /* not prepared: the surface keeps its first layer */ }
    }));
    root.traverse((o) => {
      // The map's sun: its direction (the viewer's own sun light is tuned to look like CS2).
      if (o.isDirectionalLight) {
        const from = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
        const to = new THREE.Vector3().setFromMatrixPosition(o.target.matrixWorld);
        if (from.distanceTo(to) > 0) this.toSun.copy(from.sub(to).normalize());
        this.sun.color.copy(o.color);
        o.visible = false;
      }
      if (o.isLight) o.visible = false;
      if (!o.isMesh) return;
      // Retakes-only barriers and editor-only surfaces aren't in a normal game.
      const tex = [].concat(o.material)[0]?.map?.name || "";
      const shader = [].concat(o.material)[0]?.userData?.vmat?.ShaderName || "";
      if (/^retake_/i.test(o.name) || /tools(solid)?blocklight|wrongway/.test(tex)) { o.visible = false; return; }
      // Drifting-dust planes (a soft effect in CS2, solid sheets without its shader) and what's left
      // of a shutter once it's shot off (shown only after it breaks).
      if (/csgo_effects/.test(shader) || /_remainder/.test(o.name)) { o.visible = false; return; }
      if (o.isSkinnedMesh) return;
      const baked1 = !!o.geometry.attributes.uv1;
      o.castShadow = o.receiveShadow = true;
      const swap = (m) => {
        const n = new THREE.MeshLambertMaterial({ map: m.map || null, color: m.color, transparent: m.transparent, side: m.side, alphaTest: m.map ? (m.alphaTest || (m.transparent ? 0.02 : 0.5)) : 0 });
        if (m.emissiveMap) { n.emissiveMap = m.emissiveMap; n.emissive = new THREE.Color(1, 1, 1); }
        if (baked1) { n.lightMap = baked; n.lightMapIntensity = LIGHT.baked * Math.PI; }
        // Props have no baked light (CS2 lights them from light probes): about what a wall in the
        // shade gets, or they'd be black out of the sun.
        else if (!m.emissiveMap) { n.emissiveMap = n.map; n.emissive = n.map ? new THREE.Color(LIGHT.props, LIGHT.props, LIGHT.props) : n.color.clone().multiplyScalar(LIGHT.props); }
        const vm = m.userData?.vmat;
        n.name = m.name;
        n.userData.vmat = vm;
        // Stains and paint swatches lie on the wall, see-through where their picture is.
        if (/static_overlay/.test(vm?.ShaderName || "") || vm?.IntParams?.F_OVERLAY) {
          Object.assign(n, { transparent: true, alphaTest: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        }
        // Cloth lit through from behind (awnings): both faces drawn.
        if (vm?.IntParams?.F_TRANSMISSIVE_BACKFACE_NDOTL) n.side = THREE.DoubleSide;
        const l2 = vm?.IntParams?.F_LAYERS && layerTex.get(vm.TextureParams?.g_tLayer2Color);
        if (l2 && n.map && o.geometry.attributes._texcoord_4) {
          o.geometry.setAttribute("blendw", o.geometry.attributes._texcoord_4);
          blendLayers(n, l2, layerTex.get(vm.TextureParams?.g_tBlendModulation) || null);
        }
        m.dispose();
        return n;
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    this.mapRoot = root;
    this.scene.add(root);
    this.shadowAt = null;
  }

  /** The players (header order), their names and which side each is on in the current round. */
  setPlayers(names, me) {
    for (const f of this.figures) this.scene.remove(f.group);
    this.figures = names.map((name, i) => {
      const group = makeFigure(0xaaaaaa);
      this.scene.add(group);
      const label = document.createElement("div");
      label.className = "v3d-label";
      label.textContent = name;
      const body = this.models ? new Body(this.models, group) : null;
      return { group, label, name, me: i === me, side: "", body, prev: {} };
    });
    this.labels?.replaceChildren(...this.figures.map((f) => f.label));
  }

  setSides(sides) {
    this.figures.forEach((f, i) => {
      f.side = sides[i] || "";
      f.group.userData.mat.color.setHex(SIDE_COLOR[f.side] || 0xaaaaaa);
      f.label.dataset.side = f.side;
      if (f.side) f.body?.setSide(f.side);
    });
  }

  /** CS2's agents, animations and guns (`models3d/index.json`): players show as agents from now on. */
  async loadModels(libUrl, index) {
    if (this.models || !index?.agents) return;
    const models = new Models(libUrl, index);
    await models.ready();
    this.models = models;
    for (const f of this.figures) {
      f.body = new Body(models, f.group);
      if (f.side) f.body.setSide(f.side);
    }
  }

  /** Shows the viewer in `host` (a div); the overlay layer gets the name labels. */
  mount(host) {
    this.host = host;
    host.prepend(this.canvas);
    this.labels = host.querySelector(".v3d-labels") || host.appendChild(Object.assign(document.createElement("div"), { className: "v3d-labels" }));
    this.labels.replaceChildren(...this.figures.map((f) => f.label));
    this.resize();
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  resize() {
    if (!this.host) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fpCamera.aspect = w / h;
    this.fpCamera.updateProjectionMatrix();
  }

  /** Puts everyone where they are at fractional sample `f` of round `r`; the camera follows `pov`
   *  (a player index) or the free camera. */
  frame(r, f, dt = 0, weapons = []) {
    const s = this.tmp, b = this.tmp2 || (this.tmp2 = {});
    const v = new THREE.Vector3();
    const step = this.step || 2;
    let deathCam = null;
    for (let i = 0; i < this.figures.length; i++) {
      const fig = this.figures[i];
      sampleAt(r, i, f, s);
      const alive = s.hp > 0;
      const hidden = !alive || i === this.pov;
      fig.group.visible = !hidden;
      fig.alive = alive;
      fig.hp = s.hp;
      fig.group.rotation.order = "YXZ";
      if (!alive) {
        // Killed earlier this round: the body where they fell (CS2 leaves it there).
        const d = lastAlive(r, i);
        if (d < 0 || f < d) continue;
        sampleAt(r, i, d, s);
        const p = Math.min(1, ((f - d) * step) / 64 / FALL_S);
        const e = p * p;
        toWorld(s.x, s.y, s.z, fig.group.position);
        if (i === this.pov) {
          // Watching them: CS2's death cam (placed once everyone else is, below).
          deathCam = { at: toWorld(s.x, s.y, s.z + EYE, new THREE.Vector3()), yaw: s.yaw, secs: ((f - d) * step) / 64, victim: i, s: { ...s } };
        }
        if (!fig.body?.ready) continue;
        fig.group.position.y += 0.12 * e;
        fig.group.rotation.y = s.yaw * Math.PI / 180;
        fig.group.rotation.x = -e * Math.PI / 2;
        fig.body.hold("", fig.side);
        // Your own body stays out of the death cam until it has pulled back.
        fig.group.visible = i !== this.pov || ((f - d) * step) / 64 > 0.9;
        continue;
      }
      toWorld(s.x, s.y, s.z, fig.group.position);
      fig.group.rotation.y = s.yaw * Math.PI / 180;
      fig.group.rotation.x = 0;
      if (fig.body?.ready) {
        // How they're moving (over the last 1/8 s), relative to where they face.
        sampleAt(r, i, f - 4, b);
        const secs = (4 * step) / 64;
        const vx = (s.x - b.x) / secs, vy = (s.y - b.y) / secs, vz = (s.z - b.z) / secs;
        const yr = s.yaw * Math.PI / 180;
        const move = { speed: Math.hypot(vx, vy), ahead: vx * Math.cos(yr) + vy * Math.sin(yr), right: vx * Math.sin(yr) - vy * Math.cos(yr), vz, duck: s.duck, pitch: s.pitch };
        fig.body.hold(weapons[i] || "", fig.side);
        fig.body.pose(move, setOf(weapons[i]), dt);
        fig.group.scale.y = 1;
        fig.group.userData.shape.visible = false;
      } else {
        fig.group.scale.y = 1 - 0.25 * s.duck;
        fig.group.userData.aim.rotation.x = s.pitch * Math.PI / 180;
        fig.group.userData.shape.visible = true;
      }
      fig.eye = toWorld(s.x, s.y, s.z + EYE - CROUCH_DROP * s.duck, fig.eye || new THREE.Vector3());
      fig.aim = viewDir(s.yaw, s.pitch, fig.aim || new THREE.Vector3());
      fig.scoped = s.scoped;
      if (i === this.pov) {
        this.camera.position.copy(fig.eye);
        this.camera.lookAt(v.copy(fig.eye).add(viewDir(s.yaw, s.pitch)));
        Object.assign(this.free, { yaw: s.yaw, pitch: s.pitch });
        this.free.pos.set(s.x, s.y, s.z + EYE - CROUCH_DROP * s.duck);
      }
    }
    if (deathCam) this._deathCam(deathCam, r.start + f * step);
    if (this.pov == null) {
      const p = this.free.pos;
      toWorld(p.x, p.y, p.z, this.camera.position);
      this.camera.lookAt(v.copy(this.camera.position).add(viewDir(this.free.yaw, this.free.pitch)));
    }
    this._bomb(r, f);
    // Scoped in with a sniper: the view zooms and the gun leaves the screen (the page draws the scope).
    const pf = this.pov != null ? this.figures[this.pov] : null;
    this.scoped = !!(pf?.alive && pf.scoped && SNIPERS.test(weapons[this.pov] || ""));
    const fov = this.scoped ? SCOPE_VFOV : VFOV;
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.effects.update(r.start + f * step);
    const kick = this._gunfire(r, r.start + f * step);
    this.fpTick = r.start + f * step;
    this.fpRound = r;
    this._shadows();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this._firstPerson(weapons, dt, kick);
    this._labels();
  }

  /** Who killed whom this round: [{ tick, victim, attacker }] (player numbers), for the death cam. */
  setKills(kills) {
    this.kills = kills || [];
  }

  /** The watched player is dead: like CS2, the view rises from where they fell and turns to whoever
   *  killed them, pulling back a little. */
  _deathCam(dc, tick) {
    const k = this.kills?.filter((x) => x.victim === dc.victim && x.tick <= tick + 4).pop();
    const killer = k ? this.figures[k.attacker] : null;
    const rise = Math.min(1, dc.secs / 0.8);
    const eye = dc.at.clone();
    eye.y += 0.35 * rise;
    let look;
    if (killer?.eye && killer !== this.figures[dc.victim]) {
      look = killer.alive ? killer.eye.clone() : killer.group.position.clone();
    } else {
      look = eye.clone().add(viewDir(dc.yaw, 25));
    }
    const dir = look.clone().sub(eye).normalize();
    // Back off from the body along the line to the killer, so both are in view.
    this.camera.position.copy(eye).addScaledVector(dir, -1.4 * rise);
    this.camera.lookAt(look);
    const yaw = Math.atan2(dir.x, dir.z) * 180 / Math.PI;
    Object.assign(this.free, { yaw, pitch: -Math.asin(dir.y) * 180 / Math.PI });
    this.free.pos.set(dc.s.x, dc.s.y, dc.s.z + EYE);
  }

  /** This round's bomb plant: { tick, player } (the planter's number), or null. */
  setPlant(plant) {
    this.plant = plant;
    if (this.c4) this.c4.userData.at = null;
  }

  /** The planted bomb on the ground where it was planted, its light blinking. */
  _bomb(r, f) {
    const tick = r.start + f * (this.step || 2);
    const on = !!this.plant && tick >= this.plant.tick && !!this.models;
    if (!on) { if (this.c4) this.c4.visible = false; return; }
    if (!this.c4) {
      this.c4 = new THREE.Group();
      this.c4.userData.light = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.fire.tex, color: 0xff2a1a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      this.c4.userData.light.scale.setScalar(0.12);
      this.c4.add(this.c4.userData.light);
      this.scene.add(this.c4);
      this.models.gun("c4")?.then((proto) => {
        if (!proto) return;
        const m = proto.clone();
        // Lying flat on the ground.
        m.rotation.set(-Math.PI / 2, 0, 0);
        this.c4.add(m);
      });
    }
    if (!this.c4.userData.at) {
      const s = sampleAt(r, this.plant.player, (this.plant.tick - r.start) / (this.step || 2), {});
      const yr = s.yaw * Math.PI / 180;
      // Just in front of the planter's feet.
      this.c4.userData.at = toWorld(s.x + Math.cos(yr) * 14, s.y + Math.sin(yr) * 14, s.z + 1);
      this.c4.rotation.y = yr;
    }
    this.c4.position.copy(this.c4.userData.at);
    this.c4.visible = true;
    // CS2's bomb beeps faster as it runs down; the light blinks with it.
    const secs = (tick - this.plant.tick) / 64;
    const period = Math.max(0.15, 1 - secs / 45);
    this.c4.userData.light.position.set(0, 0.09, 0);
    this.c4.userData.light.visible = (secs % period) < 0.08;
  }

  /** The first-person gun's metal: lit by a soft sky-and-ground surround besides the lights. */
  _fpMetal(fp) {
    if (!fp.gun || fp.metal) return;
    fp.metal = true;
    if (!this.fpScene.environment) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      const sc = new THREE.Scene();
      sc.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: "varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "varying vec3 vP; void main() { float h = normalize(vP).y; gl_FragColor = vec4(mix(vec3(0.42, 0.34, 0.25), vec3(0.75, 0.82, 0.92), smoothstep(-0.15, 0.35, h)), 1.0); }",
      })));
      this.fpScene.environment = pm.fromScene(sc, 0.04).texture;
      pm.dispose();
    }
    fp.gun.traverse((o) => {
      if (!o.isMesh) return;
      const shine = (m) => new THREE.MeshStandardMaterial({ map: m.map, color: m.color, transparent: m.transparent, alphaTest: m.alphaTest, side: m.side, metalness: FP_METAL.metalness, roughness: FP_METAL.roughness, envMapIntensity: FP_METAL.env });
      o.material = Array.isArray(o.material) ? o.material.map(shine) : shine(o.material);
    });
  }

  /** The first-person arms' clip at this moment, from the demo: reloading, drawing the gun just
   *  switched to, the shot just fired, or idle. Posed from the event times, so scrubbing shows
   *  the same as playing. Returns whether CS2's shooting clip is on. */
  _fpPose(dt) {
    const a = this.fp.actions || {}, r = this.fpRound, tick = this.fpTick, p = this.pov;
    const last = (list) => {
      if (!list?.length) return null;
      let lo = 0, hi = list.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (list[m][0] <= tick) lo = m + 1; else hi = m; }
      for (let i = lo - 1; i >= 0; i--) if (list[i][1] === p) return list[i][0];
      return null;
    };
    const shot = last(r?.shots), reload = last(r?.reloads), since = (t) => (tick - t) / 64;
    const dur = (n) => a[n]?.getClip().duration || 0;
    let on = "idle", at = 0;
    // A reload is cut short by a shot or a switch after it.
    if (reload != null && since(reload) < dur("reload") && !(shot > reload) && !(this.fpSince > reload)) { on = "reload"; at = since(reload); }
    else if (this.fpSince != null && since(this.fpSince) >= 0 && since(this.fpSince) < dur("draw")) { on = "draw"; at = since(this.fpSince); }
    else if (shot != null && since(shot) < dur("shoot1")) { on = "shoot1"; at = since(shot); }
    for (const [name, action] of Object.entries(a)) {
      action.setEffectiveWeight(name === on ? 1 : 0);
      if (name === on && on !== "idle") action.time = at;
    }
    if (a.idle) a.idle.time = (a.idle.time + (on === "idle" ? dt : 0)) % Math.max(0.01, dur("idle"));
    this.fp.mixer.update(0);
    return on === "shoot1";
  }

  /** Shots this moment: flashes and tracers in the world; returns how far the watched player's gun kicks. */
  _gunfire(r, tick) {
    const who = (p) => {
      const fig = this.figures[p];
      if (!fig?.group.visible || !fig.aim) return null;
      const muzzle = fig.body?.muzzle() || (fig.eye && fig.eye.clone().addScaledVector(fig.aim, 0.7));
      return muzzle ? { muzzle, dir: fig.aim } : null;
    };
    let fp = null;
    const fig = this.pov != null ? this.figures[this.pov] : null;
    const m = this.fp?.gun?.userData.muzzle;
    if (fig?.alive && fig.aim) {
      fp = { index: this.pov, muzzle: null, start: null, dir: null };
      if (m) {
        this.fpCamera.quaternion.copy(this.camera.quaternion);
        this.fpCamera.updateMatrixWorld(true);
        fp.muzzle = this.fp.gun.localToWorld(new THREE.Vector3(m[0], m[1], m[2]));
        // The tracer leaves from where the gun's muzzle is on screen, toward the crosshair.
        const ndc = fp.muzzle.clone().project(this.fpCamera);
        const ray = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
        fp.start = this.camera.position.clone().addScaledVector(ray, 0.6);
        fp.dir = this.camera.position.clone().addScaledVector(fig.aim, 60).sub(fp.start).normalize();
      }
    }
    return this.fire.update(r.shots, tick, who, fp);
  }

  /** Through a player's eyes: their arms and gun, as CS2 draws them. */
  _firstPerson(weapons, dt, kick = 0) {
    const fig = this.pov != null ? this.figures[this.pov] : null;
    // Nothing in hand (switching weapons) or the bomb planted: no first-person view, like CS2.
    const held = fig?.alive && this.models ? weapons[this.pov] || "" : "";
    const name = held === "planted_c4" ? "" : held;
    const key = name === "knife" ? `knife_default_${fig?.side === "CT" ? "ct" : "t"}` : name;
    const want = fig && key ? `${fig.side}|${key}` : null;
    if (want !== this.fpWant) {
      // Switched weapons while playing on: the new one is drawn (not after a jump on the timeline).
      const same = this.fpWant && this.fpPov === this.pov && this.lastFpTick != null && Math.abs(this.fpTick - this.lastFpTick) < 32;
      this.fpSince = same ? this.fpTick : null;
      this.fpPov = this.pov;
      this.fpWant = want;
      if (this.fp) this.fpCamera.remove(this.fp.rig);
      this.fp = null;
      if (want) {
        this.models.firstPerson(fig.side, key).then((fp) => {
          if (!fp || this.fpWant !== want) return;
          this.fp = fp;
          this._fpMetal(fp);
          this.fpCamera.add(fp.rig);
          this.onInput?.();
        });
      }
    }
    this.lastFpTick = this.fpTick;
    if (!this.fp || this.scoped) return;
    const shooting = this._fpPose(dt);
    // Each shot kicks the gun back and up a little (more without CS2's shooting clip).
    const k = kick * (shooting ? 0.35 : 1);
    this.fp.rig.position.copy(this.fp.base);
    this.fp.rig.position.z += 0.03 * k;
    this.fp.rig.position.y += 0.004 * k;
    this.fp.rig.rotation.x = 0.045 * k;
    this.fpCamera.quaternion.copy(this.camera.quaternion);
    this.fpCamera.updateMatrixWorld(true);
    // Lit like the world: full sun only where the sun reaches the eye (checked a few times a second).
    const now = performance.now();
    if (!this.sunAt || now - this.sunAt > 250 || this.camera.position.distanceTo(this.sunFrom) > 1) {
      this.sunAt = now;
      this.sunFrom = this.camera.position.clone();
      this.ray.set(this.camera.position, this.toSun);
      this.ray.far = 80;
      const hit = this.mapRoot ? this.ray.intersectObject(this.mapRoot, true).find((h) => h.object.visible) : null;
      this.fpSunlit = !hit;
    }
    this.fpSun.position.copy(this.toSun).multiplyScalar(10);
    this.fpSun.intensity = this.fpSunlit ? LIGHT.sun * 0.7 : 0;
    this.fpSky.intensity = FP_METAL.sky[this.fpSunlit ? 0 : 1] + (this.fire.fpFlash.visible ? 3 : 0);
    this.renderer.clearDepth();
    this.renderer.render(this.fpScene, this.fpCamera);
  }

  /** How far the map's surfaces are from `center` in every direction (for smokes to fill the room
   *  they're in): a function from a direction to meters (up to 12), or null before the map is in.
   *  Six tiny renders of the map's distance, one each way, read back once. */
  _probe(center) {
    if (!this.mapRoot) return null;
    const N = 32, FAR = 12;
    if (!this.probeRT) {
      this.probeRT = new THREE.WebGLRenderTarget(N, N, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      this.probeMat = new THREE.ShaderMaterial({
        uniforms: { c: { value: new THREE.Vector3() } },
        vertexShader: "varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
        fragmentShader: `uniform vec3 c; varying vec3 vW; void main() { gl_FragColor = vec4(clamp(length(vW - c) / ${FAR.toFixed(1)}, 0.0, 1.0), 0.0, 0.0, 1.0); }`,
        side: THREE.DoubleSide,
      });
      this.probeCam = new THREE.PerspectiveCamera(90, 1, 0.05, FAR);
    }
    const r = this.renderer, cam = this.probeCam;
    const saved = { autoClear: r.autoClear, target: r.getRenderTarget(), color: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha(), bg: this.scene.background, shadows: r.shadowMap.needsUpdate };
    const hidden = this.scene.children.filter((o) => o !== this.mapRoot && o.visible);
    hidden.forEach((o) => (o.visible = false));
    this.scene.background = null;
    this.scene.overrideMaterial = this.probeMat;
    this.probeMat.uniforms.c.value.copy(center);
    r.shadowMap.needsUpdate = false;
    r.autoClear = true;
    r.setClearColor(0xff0000, 1);
    const faces = [];
    const ups = [[1, 0, 0, 0, 1, 0], [-1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 1, 0], [0, 0, -1, 0, 1, 0], [0, 1, 0, 0, 0, 1], [0, -1, 0, 0, 0, 1]];
    for (const [x, y, z, ux, uy, uz] of ups) {
      cam.position.copy(center);
      cam.up.set(ux, uy, uz);
      cam.lookAt(center.x + x, center.y + y, center.z + z);
      cam.updateMatrixWorld(true);
      r.setRenderTarget(this.probeRT);
      r.render(this.scene, cam);
      const buf = new Uint8Array(N * N * 4);
      r.readRenderTargetPixels(this.probeRT, 0, 0, N, N, buf);
      faces.push({ inv: cam.quaternion.clone().invert(), buf });
    }
    this.scene.overrideMaterial = null;
    this.scene.background = saved.bg;
    hidden.forEach((o) => (o.visible = true));
    r.setRenderTarget(saved.target);
    r.setClearColor(saved.color, saved.alpha);
    r.autoClear = saved.autoClear;
    r.shadowMap.needsUpdate = saved.shadows;
    const v = new THREE.Vector3();
    return (dir) => {
      for (const f of faces) {
        v.copy(dir).applyQuaternion(f.inv);
        if (v.z >= 0 || Math.abs(v.x) > -v.z * 1.0001 || Math.abs(v.y) > -v.z * 1.0001) continue;
        const px = Math.min(N - 1, Math.floor(((v.x / -v.z + 1) / 2) * N)), py = Math.min(N - 1, Math.floor(((v.y / -v.z + 1) / 2) * N));
        return (f.buf[(py * N + px) * 4] / 255) * FAR;
      }
      return FAR;
    };
  }

  _shadows() {
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    const focus = this.camera.position.clone().addScaledVector(look, 25);
    if (this.shadowAt && this.shadowAt.distanceTo(focus) < 8) return;
    this.shadowAt = focus;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.toSun, 200);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
  }

  _labels() {
    if (!this.host) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const f of this.figures) {
      // Through a player's eyes there are no names over heads, like CS2's own demo view.
      if (!f.group.visible || !f.alive || this.pov != null) { f.label.hidden = true; continue; }
      v.copy(f.group.position);
      v.y += 1.95 * f.group.scale.y;
      v.project(this.camera);
      const off = v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1;
      f.label.hidden = off;
      if (!off) f.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  /** Free camera: drag to look, WASD to move (Q/E down/up, Shift faster), wheel to move ahead. */
  _bindInput() {
    let drag = null;
    this.canvas.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY }; this.canvas.focus(); });
    window.addEventListener("mouseup", () => { drag = null; });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      if (this.pov != null) this.onFreeCam?.();
      this.free.yaw -= dx * 0.15;
      this.free.pitch = Math.max(-89, Math.min(89, this.free.pitch + dy * 0.15));
      this.onInput?.();
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.pov != null) this.onFreeCam?.();
      this.moveFree(-Math.sign(e.deltaY) * 120, 0, 0);
      this.onInput?.();
    }, { passive: false });
    this.canvas.addEventListener("keydown", (e) => { if ("wasdqe".includes(e.key.toLowerCase()) || e.key === "Shift") this.free.keys.add(e.key.toLowerCase()); });
    this.canvas.addEventListener("keyup", (e) => this.free.keys.delete(e.key.toLowerCase()));
    this.canvas.addEventListener("blur", () => this.free.keys.clear());
  }

  /** The free camera above and behind where the living players are, looking down at them. */
  overview(r, f) {
    const s = {};
    let n = 0, x = 0, y = 0, z = 0;
    for (let i = 0; i < this.figures.length; i++) {
      sampleAt(r, i, f, s);
      if (s.hp > 0) { x += s.x; y += s.y; z += s.z; n++; }
    }
    if (!n) return;
    Object.assign(this.free, { yaw: 90, pitch: 50 });
    this.free.pos.set(x / n, y / n - 900, z / n + 1100);
  }

  /** Moves the free camera: ahead, right, up (game units). */
  moveFree(ahead, right, up) {
    const y = this.free.yaw * Math.PI / 180, p = this.free.pitch * Math.PI / 180;
    const fx = Math.cos(p) * Math.cos(y), fy = Math.cos(p) * Math.sin(y), fz = -Math.sin(p);
    this.free.pos.x += fx * ahead + Math.sin(y) * right;
    this.free.pos.y += fy * ahead - Math.cos(y) * right;
    this.free.pos.z += fz * ahead + up;
  }

  /** Free-camera keys held: moves it for `dt` seconds; whether it moved. */
  stepKeys(dt) {
    const k = this.free.keys;
    if (!k.size) return false;
    const speed = (k.has("shift") ? 900 : 350) * dt;
    const ahead = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0), right = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0), up = (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0);
    if (!ahead && !right && !up) return false;
    if (this.pov != null) this.onFreeCam?.();
    this.moveFree(ahead * speed, right * speed, up * speed);
    return true;
  }
}

let viewer = null;
/** The app's one 3D viewer. */
export function getViewer() {
  if (!viewer) viewer = new Viewer();
  return viewer;
}
