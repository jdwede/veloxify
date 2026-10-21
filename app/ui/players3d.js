// Players in the 3D replay as CS2's own agents: the model from the user's CS2 install, CS2's
// animations (idle, walking, running, crouching, in the air) blended by how each player moves, the
// spine bent by where they aim, and the gun they're holding in their hand.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const PISTOLS = new Set(["glock", "usp_silencer", "hkp2000", "p250", "fiveseven", "tec9", "cz75a", "deagle", "revolver", "elite", "taser"]);
/** Which animation set goes with a weapon: rifles (all long guns), pistols, or knife (also grenades, the bomb). */
export const setOf = (w) => (!w ? "rifle" : PISTOLS.has(w) ? "pistol" : /knife|bayonet|grenade|flashbang|molotov|decoy|c4/.test(w) ? "knife" : "rifle");
const DIRS = { n: 0, e: Math.PI / 2, s: Math.PI, w: -Math.PI / 2 };
// The speeds (game units a second) CS2's walk, run and crouch cycles are made for.
const SPEED = { walk: 130, run: 245, crouch: 85 };
// Gun meshes come in the export's axes, the hand's weapon bone in the game's: (x, y, z) = (z, x, y).
const GUN_FIX = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
// The first-person arms and gun sit this far from the eye (meters: right, up, back), matched against
// CS2's own picture with the default viewmodel settings.
const FP_OFFSET = [0, -0.1, -0.05];
// How much of the aim pitch each spine bone takes.
const SPINE = [["spine_1", 0.3], ["spine_2", 0.35], ["spine_3", 0.35]];

// Players and guns are shaded like the map (plain diffuse): no reflections to fake without CS2's light probes.
const diffuse = (m) => {
  if (m.isMeshLambertMaterial) return m;
  return new THREE.MeshLambertMaterial({ map: m.map || null, color: m.color, transparent: m.transparent, alphaTest: m.alphaTest, side: m.side, emissiveMap: m.emissiveMap || null, emissive: m.emissiveMap ? new THREE.Color(1, 1, 1) : new THREE.Color(0, 0, 0) });
};
// The walls get CS2's baked bounce light; players move, so they get this much of their own color
// instead (about what a wall in the shade gets), or they'd be black in every shadow.
const AMBIENT = 0.22;
const ambient = (m) => {
  if (!m.emissiveMap && m.map) { m.emissiveMap = m.map; m.emissive = new THREE.Color(AMBIENT, AMBIENT, AMBIENT); }
  return m;
};

/** The tip of a gun's barrel in its own space (the barrel points along +z): the middle of its
 *  frontmost points. Null for anything without a barrel worth flashing. */
function muzzleOf(root) {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3(), pts = [];
  let front = -Infinity;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 2) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      pts.push(v.x, v.y, v.z);
      if (v.z > front) front = v.z;
    }
  });
  if (!pts.length) return null;
  let x = 0, y = 0, n = 0;
  for (let i = 0; i < pts.length; i += 3) if (pts[i + 2] > front - 0.015) { x += pts[i]; y += pts[i + 1]; n++; }
  return [x / n, y / n, front];
}

/** CS2's agents, animations and guns as prepared in `models3d/` (see its index.json). */
export class Models {
  constructor(libUrl, index) {
    this.libUrl = libUrl;
    this.index = index;
    this.manager = new THREE.LoadingManager();
    this.manager.setURLModifier((u) => (u.startsWith("vx:") ? libUrl(u.slice(3)) : u));
    this.agents = {};
    this.clips = {};
    this.guns = new Map();
  }

  /** A glb under models3d/, its textures found next to it. */
  load(rel) {
    const loader = new GLTFLoader(this.manager);
    const dir = rel.split("/").slice(0, -1).join("/");
    loader.setResourcePath(`vx:models3d/${dir}/`);
    return loader.loadAsync(this.libUrl(`models3d/${rel}`));
  }

  /** Loads both agents and every clip. */
  async ready() {
    const sets = Object.entries(this.index.anims || {});
    await Promise.all(sets.flatMap(([set, clips]) => Object.entries(clips).map(async ([name, rel]) => {
      const g = await this.load(rel);
      const clip = g.animations[0];
      if (!clip) return;
      // Root motion would carry the agent off: the replay already moves them.
      clip.tracks = clip.tracks.filter((t) => !/^root_motion\.(position|quaternion)/.test(t.name));
      (this.clips[set] ||= {})[name] = clip;
    })));
    await Promise.all(Object.keys(this.index.agents || {}).map(async (side) => { this.agents[side] = await this._agent(side); }));
  }

  /** An agent ready to be copied: its meshes on CS2's animation skeleton (bones matched by name). */
  async _agent(side) {
    const a = this.index.agents[side];
    const base = this.index.anims?.rifle?.idle;
    const [g, bones, skelFile] = await Promise.all([this.load(a.model), fetch(this.libUrl(`models3d/${a.bones}`)).then((r) => r.json()), this.load(base)]);
    (this.agentFiles ||= {})[side] = { g, bones };
    const parser = skelFile.parser;
    const skinDef = parser.json.skins[0];
    const joints = await Promise.all(skinDef.joints.map((i) => parser.getDependency("node", i)));
    const ibm = await parser.getDependency("accessor", skinDef.inverseBindMatrices);
    const skel = new THREE.Skeleton(joints, joints.map((_, i) => new THREE.Matrix4().fromArray(ibm.array, i * 16)));
    const root = skelFile.scene;
    root.traverse((o) => { if (o.isMesh || o.isPoints) o.visible = false; });
    const at = new Map(joints.map((b, i) => [b.name, i]));
    // The agent's own bone numbers → the animation skeleton's (helpers follow their nearest animated parent).
    const remap = bones.names.map((_, i) => {
      let k = i;
      while (k >= 0 && !at.has(bones.names[k])) k = bones.parents[k];
      return k >= 0 ? at.get(bones.names[k]) : 0;
    });
    g.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.skinIndex || /firstperson|defusekit/.test(o.name)) return;
      const geo = o.geometry.clone();
      const si = geo.attributes.skinIndex;
      for (let i = 0; i < si.count; i++) for (let c = 0; c < 4; c++) si.setComponent(i, c, remap[si.getComponent(i, c)] ?? 0);
      const mats = [].concat(o.material).map((m) => ambient(diffuse(m)));
      const sm = new THREE.SkinnedMesh(geo, Array.isArray(o.material) ? mats : mats[0]);
      sm.frustumCulled = false;
      root.add(sm);
      sm.bind(skel, new THREE.Matrix4());
    });
    return root;
  }

  /** The full-body skeleton's bind pose by bone name: the agents' arms were made on it. */
  _bodyBind() {
    this.bodyBind ||= this.load(this.index.anims.rifle.idle).then(async (f) => {
      const skin = f.parser.json.skins[0];
      const joints = await Promise.all(skin.joints.map((i) => f.parser.getDependency("node", i)));
      const ibm = await f.parser.getDependency("accessor", skin.inverseBindMatrices);
      return new Map(joints.map((b, i) => [b.name, new THREE.Matrix4().fromArray(ibm.array, i * 16)]));
    });
    return this.bodyBind;
  }

  /** The first-person arms (this side's agent) and gun for a weapon, posed by CS2's first-person
   *  idle clip: { rig, mixer }, built once each; null when it can't be. */
  firstPerson(side, weapon) {
    const key = `${side}|${weapon}`;
    (this.fp ||= new Map());
    if (!this.fp.has(key)) this.fp.set(key, this._firstPerson(side, weapon).catch((e) => { console.warn("3D replay: first-person view", e); return null; }));
    return this.fp.get(key);
  }

  async _firstPerson(side, weapon) {
    const rel = this.index.firstperson?.[weapon];
    const files = this.agentFiles?.[side];
    if (!rel || !files) return null;
    // Shooting, reloading and drawing (CS2's own clips for this weapon), when prepared.
    const extra = Object.entries(this.index.firstperson_clips?.[weapon] || {});
    const [clipFile, bind, gun, ...others] = await Promise.all([this.load(rel), this._bodyBind(), this.gun(weapon), ...extra.map(([, r]) => this.load(r).catch(() => null))]);
    const skin = clipFile.parser.json.skins[0];
    const joints = await Promise.all(skin.joints.map((i) => clipFile.parser.getDependency("node", i)));
    const ibm = await clipFile.parser.getDependency("accessor", skin.inverseBindMatrices);
    const skel = new THREE.Skeleton(joints, joints.map((j, i) => bind.get(j.name) || new THREE.Matrix4().fromArray(ibm.array, i * 16)));
    const root = clipFile.scene;
    root.traverse((o) => { if (o.isMesh || o.isPoints) o.visible = false; });
    const at = new Map(joints.map((b, i) => [b.name, i]));
    const { g, bones } = files;
    const remap = bones.names.map((_, i) => {
      let k = i;
      while (k >= 0 && !at.has(bones.names[k])) k = bones.parents[k];
      return k >= 0 ? at.get(bones.names[k]) : 0;
    });
    g.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.skinIndex || !/firstperson/.test(o.name)) return;
      const geo = o.geometry.clone();
      const si = geo.attributes.skinIndex;
      for (let i = 0; i < si.count; i++) for (let c = 0; c < 4; c++) si.setComponent(i, c, remap[si.getComponent(i, c)] ?? 0);
      const sm = new THREE.SkinnedMesh(geo, Array.isArray(o.material) ? o.material.map(diffuse) : diffuse(o.material));
      sm.frustumCulled = false;
      root.add(sm);
      sm.bind(skel, new THREE.Matrix4());
    });
    const wpn = root.getObjectByName("wpn");
    let held = null;
    if (gun && wpn) {
      const hand = new THREE.Group();
      hand.matrixAutoUpdate = false;
      hand.matrix.copy(GUN_FIX);
      held = gun.clone();
      hand.add(held);
      wpn.add(hand);
    }
    // The game's forward (the export's +z) points away from the camera.
    const rig = new THREE.Group();
    rig.rotation.y = Math.PI;
    rig.position.set(...FP_OFFSET);
    rig.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const actions = {};
    const clip = clipFile.animations[0];
    if (clip) actions.idle = mixer.clipAction(clip);
    extra.forEach(([kind], i) => { const c = others[i]?.animations[0]; if (c) actions[kind] = mixer.clipAction(c); });
    for (const a of Object.values(actions)) { a.play(); a.setEffectiveWeight(0); }
    actions.idle?.setEffectiveWeight(1);
    mixer.update(0);
    return { rig, mixer, actions, gun: held, base: rig.position.clone() };
  }

  /** A gun's model (shared; copy it per player), or null when it isn't prepared. */
  gun(name) {
    const rel = this.index.weapons?.[name];
    if (!rel) return null;
    if (!this.guns.has(name)) {
      this.guns.set(name, this.load(rel).then((g) => {
        // Guns carry an old ("legacy") copy beside the current one; knives have only that one.
        let current = false;
        g.scene.traverse((o) => { if (o.isMesh && !/body_legacy/.test(o.name)) current = true; });
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          if (current && /body_legacy/.test(o.name)) o.visible = false;
          o.material = Array.isArray(o.material) ? o.material.map((m) => ambient(diffuse(m))) : ambient(diffuse(o.material));
        });
        g.scene.userData.muzzle = muzzleOf(g.scene);
        return g.scene;
      }).catch(() => null));
    }
    return this.guns.get(name);
  }
}

/** One player's agent: posed every frame from how they move and aim. */
export class Body {
  constructor(models, parent) {
    this.models = models;
    this.parent = parent;
    this.bySide = {};
    this.cur = null;
    this.gunName = undefined;
  }

  /** The agent for this side (each side's copy made once). */
  setSide(side) {
    if (this.cur?.side === side) return;
    if (this.cur) this.cur.root.visible = false;
    if (!this.bySide[side] && this.models.agents[side]) {
      const root = cloneSkinned(this.models.agents[side]);
      const mixer = new THREE.AnimationMixer(root);
      const actions = {};
      for (const [set, clips] of Object.entries(this.models.clips)) {
        for (const [name, clip] of Object.entries(clips)) {
          const a = mixer.clipAction(clip);
          a.setEffectiveWeight(0);
          a.play();
          (actions[set] ||= {})[name] = a;
        }
      }
      const spine = SPINE.map(([n, share]) => [root.getObjectByName(n), share]).filter(([b]) => b);
      const hand = new THREE.Group();
      hand.matrixAutoUpdate = false;
      hand.matrix.copy(GUN_FIX);
      root.getObjectByName("wpn")?.add(hand);
      this.parent.add(root);
      this.bySide[side] = { side, root, mixer, actions, spine, hand, gun: null };
      this.gunName = undefined;
    }
    this.cur = this.bySide[side] || null;
    if (this.cur) this.cur.root.visible = true;
    this.gunName = undefined;
  }

  get ready() { return !!this.cur; }

  /** Holds this weapon (name as the 2D replay gives it). */
  hold(name, side) {
    const key = name === "knife" ? `knife_default_${side === "CT" ? "ct" : "t"}` : name;
    if (!this.cur || key === this.gunName) return;
    this.gunName = key;
    const hand = this.cur.hand;
    hand.clear();
    const p = key && this.models.gun(key);
    if (!p) return;
    p.then((proto) => { if (proto && this.gunName === key && this.cur?.hand === hand) hand.add(proto.clone()); });
  }

  /** Poses the agent: `move` has speed, ahead/right (units/s), vz, duck, pitch; `dt` advances the cycles. */
  pose(move, set, dt) {
    const c = this.cur;
    if (!c) return;
    const acts = c.actions[set] ? c.actions : null;
    if (!acts) return;
    const moving = Math.min(1, Math.max(0, (move.speed - 15) / 45));
    const run = Math.min(1, Math.max(0, (move.speed - 150) / 70));
    const crouch = move.duck > 0.5;
    const air = Math.abs(move.vz) > 160;
    const a = Math.atan2(move.right, move.ahead);
    const dw = {};
    let sum = 0;
    for (const [d, ang] of Object.entries(DIRS)) { dw[d] = Math.max(0, Math.cos(a - ang)) ** 2; sum += dw[d]; }
    for (const d in dw) dw[d] /= sum || 1;
    const want = {};
    if (air) want.inair_stand = 1;
    else if (crouch) {
      want.idle_crouch = 1 - moving;
      for (const d in dw) want[`crouch_${d}`] = moving * dw[d];
    } else {
      want.idle = 1 - moving;
      for (const d in dw) { want[`walk_${d}`] = moving * (1 - run) * dw[d]; want[`run_${d}`] = moving * run * dw[d]; }
    }
    for (const [s, list] of Object.entries(acts)) {
      for (const [name, action] of Object.entries(list)) {
        // A clip missing from this set comes from the rifle set.
        const own = s === set ? want[name] || 0 : s === "rifle" && !acts[set][name] ? want[name] || 0 : 0;
        action.setEffectiveWeight(own);
        const kind = name.split("_")[0];
        action.timeScale = SPEED[kind] ? Math.min(1.6, Math.max(0.6, move.speed / SPEED[kind])) : 1;
      }
    }
    c.mixer.update(dt);
    // Aim: bend the spine up or down (the head, arms and gun follow).
    c.root.updateMatrixWorld(true);
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(c.root.getWorldQuaternion(new THREE.Quaternion()));
    const pq = new THREE.Quaternion(), q = new THREE.Quaternion();
    for (const [bone, share] of c.spine) {
      bone.parent.getWorldQuaternion(pq);
      q.setFromAxisAngle(right, -move.pitch * share * Math.PI / 180);
      bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
      bone.updateMatrixWorld(true);
    }
  }

  set visible(v) { if (this.cur) this.cur.root.visible = v; }

  /** Where the held gun's muzzle is (world), or null without a gun. */
  muzzle(out = new THREE.Vector3()) {
    const g = this.cur?.hand.children[0];
    const m = g?.userData.muzzle;
    if (!m) return null;
    g.updateWorldMatrix(true, false);
    return g.localToWorld(out.set(m[0], m[1], m[2]));
  }
}
