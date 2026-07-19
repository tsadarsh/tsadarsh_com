import * as THREE from 'three';
import carDesign from './car.design.json';

const info = document.getElementById('info');

// WebSocket connection to server (dev server assumes ws on localhost:3000)
const WS_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'ws://localhost:3000' : `wss://${location.host}`;
let clientId = null;
let serverSeed = null;

let wsClient = null;
const remoteCars = new Map(); // id -> { mesh, targetPos: Vector3, targetRotY, speed }
// local skin color (hex). persisted in localStorage
let localSkin = (typeof localStorage !== 'undefined' ? localStorage.getItem('car_color') : null) || '#ff3333';
let localName = (typeof localStorage !== 'undefined' ? localStorage.getItem('player_name') : null) || ('Player' + Math.floor(Math.random()*90+10));

function sendImmediateState() {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN || !clientId) return;
  const nameToSend = (typeof localName === 'string') ? localName.trim().slice(0,10) : null;
  const msg = {
    type: 'state', id: clientId, t: Date.now(), p: [state.pos.x, state.pos.y, state.pos.z], rotY: state.rotY, speed: state.speed, skin: localSkin, name: nameToSend
  };
  try { console.debug('immediate send state', msg); wsClient.send(JSON.stringify(msg)); } catch (e) { console.warn('immediate send failed', e); }
}

function connectWS() {
  wsClient = new WebSocket(WS_URL);
  wsClient.addEventListener('open', () => {
    info.textContent = 'Connected to server, waiting init...';
  });
  wsClient.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'init') {
        clientId = msg.id;
        serverSeed = msg.seed;
        console.log('INIT from server', msg);
        info.textContent = `id=${clientId} seed=${serverSeed}`;
        // re-create world using server seed so all clients share same terrain
        try {
          // remove existing chunks
          for (const [key, obj] of loadedChunks) {
            scene.remove(obj.mesh);
            if (obj.mesh.geometry) obj.mesh.geometry.dispose();
            if (obj.mesh.material) obj.mesh.material.dispose();
          }
          loadedChunks.clear();
          world = createWorld(serverSeed, { chunkSize: 32, spacing: 1.0, amplitude: 3.5 });
          // place car at spawn derived from terrain
          try {
            const sx = 0, sz = 0;
            const sy = typeof world.getHeight === 'function' ? world.getHeight(sx, sz) + 0.35 : 0.35;
            state.pos.set(sx, sy, sz);
            car.position.copy(state.pos);
            camera.position.set(state.pos.x, state.pos.y + 4, state.pos.z + 8);
          } catch (e) {}
          // request an initial chunk update
          maybeUpdateChunks();
        } catch (e) {
          console.warn('failed to create world with server seed', e);
        }
        // start sending our state periodically
        startStateSender();
        // apply local skin to our car and notify server immediately
        try { applyTintToMesh(car, localSkin); } catch (e) {}
        sendImmediateState();
      } else if (msg.type === 'update') {
        // update other players
        for (const p of msg.players) {
          // debug: log incoming player names
          try { console.debug('UPDATE player', p.id, 'name=', p.name, 'skin=', p.skin); } catch(e) {}
          if (p.id === clientId) continue; // skip self
          let rc = remoteCars.get(p.id);
          if (!rc) {
            // create remote car mesh using reported skin color if present
            let remoteSkin = '#3366ff';
            if (p.skin) remoteSkin = (typeof p.skin === 'string') ? p.skin : ('#' + (Number(p.skin)).toString(16).padStart(6,'0'));
            const g = createCarMesh(remoteSkin);
            scene.add(g);
            rc = { mesh: g, targetPos: new THREE.Vector3(), targetRotY: 0, speed: 0 };
            // store reported skin
            try { rc.mesh.userData = rc.mesh.userData || {}; rc.mesh.userData.skin = remoteSkin; } catch(e){}
            // apply reported name for remote players (create separate sprite)
            try { if (p.name) setRemoteCarName(rc, p.name); } catch(e){}
            remoteCars.set(p.id, rc);
          }
          // if server/client didn't include proper Y, compute from world height
          let py = p.p[1];
          if ((!py || py === 0) && typeof world?.getHeight === 'function') {
            py = world.getHeight(p.p[0], p.p[2]) + 0.35;
          }
          rc.targetPos.set(p.p[0], py, p.p[2]);
          // initialize mesh position if it's newly created
          if (rc.mesh.position.length() === 0) {
            rc.mesh.position.copy(rc.targetPos);
          }
          rc.targetRotY = p.rotY;
          rc.speed = p.speed;
          // update remote skin if it changed
          try {
            let remoteSkin = p.skin || null;
            if (remoteSkin && typeof remoteSkin !== 'string') remoteSkin = '#' + (Number(remoteSkin)).toString(16).padStart(6,'0');
            if (remoteSkin && rc.mesh && rc.mesh.userData && rc.mesh.userData.skin !== remoteSkin) {
              applyTintToMesh(rc.mesh, remoteSkin);
              rc.mesh.userData.skin = remoteSkin;
            }
          } catch (e) {}
          // update remote name if it changed (use separate remote sprite)
          try {
            const remoteName = typeof p.name === 'string' ? p.name.trim().slice(0,10) : null;
            if (rc && remoteName) {
              setRemoteCarName(rc, remoteName);
              // also store on mesh.userData for quick comparison
              try { rc.mesh.userData = rc.mesh.userData || {}; rc.mesh.userData.name = remoteName; } catch(e){}
            } else if (rc && !remoteName) {
              // remove if null
              disposeRemoteNameSprite(rc);
              try { if (rc.mesh.userData) rc.mesh.userData.name = null; } catch(e){}
            }
          } catch (e) {}
        }
      } else if (msg.type === 'leave') {
        const id = msg.id;
        const rc = remoteCars.get(id);
        if (rc) {
          // dispose remote name sprite textures if present
          try { disposeRemoteNameSprite(rc); } catch (e) {}
          scene.remove(rc.mesh);
          remoteCars.delete(id);
        }
      }
    } catch (e) {
      console.error('Bad message', e);
    }
  });
  wsClient.addEventListener('close', () => {
    info.textContent = 'Disconnected';
    setTimeout(connectWS, 1000);
  });
  wsClient.addEventListener('error', (e) => console.error('WS error', e));
}



function startStateSender() {
  if (!wsClient) return;
  if (window.__stateSenderInterval) return;
  window.__stateSenderInterval = setInterval(() => {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN || !clientId) return;
    const msg = {
      type: 'state',
      id: clientId,
      t: Date.now(),
      p: [state.pos.x, state.pos.y, state.pos.z],
      rotY: state.rotY,
      speed: state.speed,
      skin: localSkin,
      name: (typeof localName === 'string') ? localName.trim().slice(0,10) : null
    };
    try { console.debug('sending state', msg); wsClient.send(JSON.stringify(msg)); } catch (e) { console.warn('send failed', e); }
  }, 66); // ~15Hz
}

// --- Three.js scene (minimal) ---
import { createWorld } from './world/worldAPI.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky

// initialize a default world so chunks exist before server responds
let world = createWorld(12345, { chunkSize: 32, spacing: 1.0, amplitude: 3.5 });
// initial spawn (place car on terrain)
try {
  const sx = 0, sz = 0;
  const sy = typeof world.getHeight === 'function' ? world.getHeight(sx, sz) + 0.35 : 0.35;
  state.pos.set(sx, sy, sz);
  car.position.copy(state.pos);
} catch (e) {}

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 6, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// lighting: stronger directional light and contrasted hemispheric light for better shape definition
const hemi = new THREE.HemisphereLight(0xe0f0ff, 0x666644, 0.6);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xfff0e0, 1.2);
// lower sun angle to create longer shadows and stronger shading
dir.position.set(-10, 20, -6);
scene.add(dir);
// optional: enable shadows if desired (costly on some devices)
// renderer.shadowMap.enabled = true; dir.castShadow = false;

// simple landmarks to notice movement
const landmarkMat = new THREE.MeshStandardMaterial({ color: 0x2288ff });
const lm1 = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), landmarkMat);
lm1.position.set(10,1,0);
scene.add(lm1);
const lm2 = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), landmarkMat.clone());
lm2.position.set(-12,1,8);
scene.add(lm2);
const lm3 = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), landmarkMat.clone());
lm3.position.set(0,1,-15);
scene.add(lm3);

// Build a THREE.Group from a car design JSON
function buildCarFromDesign(design, tintColor) {
  const group = new THREE.Group();
  group.name = design.name || 'car_from_design';

  // materials
  const mats = {};
  const defs = design.materials || {};
  const tintMats = [];
  for (const key of Object.keys(defs)) {
    const d = defs[key];
    const mat = new THREE.MeshStandardMaterial({
      color: d.color || 0x999999,
      metalness: typeof d.metalness === 'number' ? d.metalness : 0.2,
      roughness: typeof d.roughness === 'number' ? d.roughness : 0.6,
      flatShading: !!d.flatShading,
      transparent: !!d.transparent,
      opacity: typeof d.opacity === 'number' ? d.opacity : 1.0
    });
    // mark tintable on material userdata so it can be updated later
    if (d.tintable) {
      mat.userData = mat.userData || {};
      mat.userData.tintable = true;
      tintMats.push(mat);
      // apply initial tint override if provided
      if (typeof tintColor !== 'undefined') {
        try { mat.color.set(tintColor); } catch (e) {}
      }
    }
    mats[key] = mat;
  }

  const wheels = [];
  const named = {};

  // helper to create primitive
  function createPart(part) {
    const type = part.type || 'box';
    let mesh = null;
    if (type === 'box') {
      const p = part.params || {};
      const sx = p.sx || 1, sy = p.sy || 1, sz = p.sz || 1;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mats[part.material] || new THREE.MeshStandardMaterial({ color: 0x888888 }));
    } else if (type === 'cylinder') {
      const p = part.params || {};
      const rTop = p.radiusTop || 0.2, rBot = p.radiusBottom || rTop, h = p.height || 0.2, seg = p.radialSegments || 8;
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mats[part.material] || new THREE.MeshStandardMaterial({ color: 0x444444 }));
      // cylinder is Y-axis by default; rotate if needed
      const axis = (p.axis || 'y').toLowerCase();
      if (axis === 'x') mesh.rotation.z = Math.PI / 2;
      else if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    } else if (type === 'plane') {
      const p = part.params || {};
      const w = p.width || 1, h = p.height || 1;
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mats[part.material] || new THREE.MeshStandardMaterial({ color: 0x888888 }));
    } else if (type === 'sphere') {
      const p = part.params || {};
      mesh = new THREE.Mesh(new THREE.SphereGeometry(p.radius || 0.5, p.widthSegments || 8, p.heightSegments || 6), mats[part.material] || new THREE.MeshStandardMaterial({ color: 0x888888 }));
    } else if (type === 'custom') {
      const p = part.params || {};
      const pos = p.positions || [];
      const idx = p.indices || [];
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      if (idx && idx.length) geom.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
      if (p.normals) geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(p.normals), 3));
      mesh = new THREE.Mesh(geom, mats[part.material] || new THREE.MeshStandardMaterial({ color: 0x888888 }));
    }

    if (!mesh) return null;

    // apply transforms
    if (part.pos) mesh.position.set(part.pos[0] || 0, part.pos[1] || 0, part.pos[2] || 0);
    if (part.rot) mesh.rotation.set(part.rot[0] || 0, part.rot[1] || 0, part.rot[2] || 0);
    if (part.scale) mesh.scale.set(part.scale[0] || 1, part.scale[1] || 1, part.scale[2] || 1);

    // collect wheels
    if (part.meta && part.meta.role === 'wheel') {
      // wrap wheel mesh in a group to match prior expectations (userData.wheel, userData.rim)
      const wp = new THREE.Group();
      mesh.rotation.x = mesh.rotation.x || 0; // ensure rotation exists
      // put wheel mesh as child at origin so rotation will spin correctly
      mesh.position.set(0, 0, 0);
      wp.add(mesh);
      // add a simple rim (small scaled cylinder) for visual
      const rim = null; // optional: could add rim here
      wp.position.set(part.pos ? part.pos[0] || 0 : 0, part.pos ? part.pos[1] || 0 : 0, part.pos ? part.pos[2] || 0 : 0);
      wp.userData = { wheel: mesh };
      if (rim) wp.userData.rim = rim;
      // mark steering
      if (part.meta && part.meta.steer) wp.userData.steer = true;
      wheels.push(wp);
      named[part.id] = wp;
      return wp;
    }

    named[part.id] = mesh;
    return mesh;
  }

  // create all parts and add to group
  for (const part of design.parts || []) {
    try {
      const node = createPart(part);
      if (!node) continue;
      group.add(node);
    } catch (e) {
      console.warn('Failed to create part', part.id, e);
    }
  }

  group.userData.wheels = wheels;
  group.userData.named = named;
  group.userData.tintMaterials = tintMats;
  return group;
}

// helper to set tint on an instantiated car mesh/group
function applyTintToMesh(group, color) {
  if (!group) return;
  try {
    // if buildCarFromDesign stored tintMaterials, use them
    if (group.userData && Array.isArray(group.userData.tintMaterials) && group.userData.tintMaterials.length) {
      for (const m of group.userData.tintMaterials) {
        try { m.color.set(color); } catch (e) {}
      }
    } else {
      // traverse and find materials with userData.tintable
      group.traverse((node) => {
        if (node.isMesh && node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          for (const mat of mats) {
            if (mat && mat.userData && mat.userData.tintable) {
              try { mat.color.set(color); } catch (e) {}
            }
          }
        }
      });
    }
    group.userData.skin = color;
  } catch (e) { console.warn('applyTint failed', e); }
}

// create a simple name sprite from text (canvas texture)
function makeNameSprite(name) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 48;
  ctx.font = `${fontSize}px sans-serif`;
  const padding = 12;
  const text = (name || '').slice(0,10);
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  canvas.width = Math.max(64, textWidth + padding * 2);
  canvas.height = fontSize + padding * 2;
  // redraw with proper size
  ctx.font = `${fontSize}px sans-serif`;
  // background (semi-transparent)
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const r = 8;
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
  roundRect(ctx, 0, 0, canvas.width, canvas.height, r);
  // text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  // scale sprite to reasonable size in world units
  const scaleFactor = 0.01; // adjust to taste
  sprite.scale.set(canvas.width * scaleFactor, canvas.height * scaleFactor, 1);
  return sprite;
}

// attach a floating name sprite for remote players (not added as child of the car group)
function createRemoteNameSprite(name) {
  try {
    const sprite = makeNameSprite(name);
    // initial position at origin; will be updated in animate loop
    sprite.position.set(0, 2.2, 0);
    sprite.userData = sprite.userData || {};
    sprite.userData.nameText = (name||'').slice(0,10);
    return sprite;
  } catch (e) { console.warn('createRemoteNameSprite failed', e); return null; }
}

// update (or add) name sprite attached to a remote car record
function setRemoteCarName(rc, name) {
  if (!rc) return;
  const safe = (typeof name === 'string') ? name.trim().slice(0,10) : '';
  try {
    // if exists and same, do nothing
    if (rc.nameSprite && rc.nameSprite.userData && rc.nameSprite.userData.nameText === safe) return;
    // remove old sprite
    if (rc.nameSprite) {
      try { scene.remove(rc.nameSprite); } catch (e) {}
      try { if (rc.nameSprite.material && rc.nameSprite.material.map) rc.nameSprite.material.map.dispose(); } catch (e) {}
      try { if (rc.nameSprite.material) rc.nameSprite.material.dispose(); } catch (e) {}
      rc.nameSprite = null;
    }
    if (!safe) return;
    const spr = createRemoteNameSprite(safe);
    if (!spr) return;
    // position above the car mesh (we'll update smoothly in animate)
    spr.position.copy(rc.mesh.position).add(new THREE.Vector3(0, 2.2, 0));
    scene.add(spr);
    rc.nameSprite = spr;
    try { console.debug('Created name sprite for', safe, 'for remote id=?'); } catch(e) {}
  } catch (e) { console.warn('setRemoteCarName failed', e); }
}

// remove remote name sprite when car leaves
function disposeRemoteNameSprite(rc) {
  if (!rc) return;
  try {
    if (rc.nameSprite) {
      try { scene.remove(rc.nameSprite); } catch (e) {}
      try { if (rc.nameSprite.material && rc.nameSprite.material.map) rc.nameSprite.material.map.dispose(); } catch (e) {}
      try { if (rc.nameSprite.material) rc.nameSprite.material.dispose(); } catch (e) {}
      rc.nameSprite = null;
    }
  } catch (e) { }
}

// createCarMesh: prefer design-driven creation; fall back to a simple primitive
function createCarMesh(color = 0xff3333) {
  try {
    if (typeof carDesign !== 'undefined' && carDesign && carDesign.parts) {
      const g = buildCarFromDesign(carDesign, color);
      // ensure userData.skin is set
      g.userData = g.userData || {};
      g.userData.skin = color;
      return g;
    }
  } catch (e) {
    console.warn('car design build failed, falling back', e);
  }
  // fallback simple box car
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 0.9), new THREE.MeshStandardMaterial({ color: color, flatShading: true }));
  body.position.y = 0.35;
  g.add(body);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const wgeo = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 6);
  function mw(x,z){ const m = new THREE.Mesh(wgeo, wheelMat); m.rotation.z = Math.PI/2; m.position.set(x,0.12,z); const gp = new THREE.Group(); gp.add(m); gp.userData = { wheel: m }; g.add(gp); g.userData = g.userData || {}; if(!g.userData.wheels) g.userData.wheels = []; g.userData.wheels.push(gp); }
  mw(0.7,0.35); mw(-0.7,0.35); mw(0.7,-0.35); mw(-0.7,-0.35);
  g.userData = g.userData || {};
  g.userData.skin = color;
  return g;
}

const car = createCarMesh(localSkin);
scene.add(car);
// apply persisted color to picker UI and wire events
const colorPicker = document.getElementById('colorPicker');
if (colorPicker) {
  try { colorPicker.value = localSkin; } catch (e) {}
  colorPicker.addEventListener('input', (ev) => {
    const v = ev.target.value;
    localSkin = v;
    try { localStorage.setItem('car_color', localSkin); } catch (e) {}
    applyTintToMesh(car, localSkin);
    // notify server of skin change immediately
    sendImmediateState();
  });
}

// name input wiring
const nameInput = document.getElementById('nameInput');
if (nameInput) {
  try { nameInput.value = localName; } catch (e) {}
  nameInput.addEventListener('input', (ev) => {
    const v = ev.target.value.slice(0,10);
    localName = v;
    try { localStorage.setItem('player_name', localName); } catch (e) {}
    // Do not display the local player's name above their own car — only broadcast it to other players
    // notify server of typed change (but we'll only force rename when user presses button)
    // we still update localName; sendImmediateState is not required here
  });
}

// rename button explicitly sends a rename request so all players refresh immediately
const renameBtn = document.getElementById('renameBtn');
if (renameBtn) {
  renameBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const nameToSend = (typeof localName === 'string') ? localName.trim().slice(0,10) : null;
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
      // still persist name locally
      try { localStorage.setItem('player_name', localName); } catch (e) {}
      return;
    }
    const msg = { type: 'rename', name: nameToSend };
    try { console.debug('sending rename', msg); wsClient.send(JSON.stringify(msg)); } catch (e) { console.warn('rename send failed', e); }
    // also send full state for redundancy
    sendImmediateState();
  });
}

// ensure initial tint applied (do not display own name locally)
applyTintToMesh(car, localSkin);

// World and chunk manager placeholders (initialized after server init)
const loadedChunks = new Map(); // key -> { mesh }
const CHUNK_RADIUS = 2; // how many chunks to load around player

// camera follow target offset (behind the car)
const camOffset = new THREE.Vector3(0, 4, -8);

// simple kinematics
const state = {
  pos: new THREE.Vector3(0, 0, 0),
  rotY: 0,
  speed: 0
};

const controls = { forward: false, back: false, left: false, right: false };

function updatePhysics(dt) {
  const accel = 8.0;
  const brake = 12.0;
  const drag = 3.0; // natural slowdown when no input
  const maxSpeed = 12.0;
  const carBaseHeight = 0.35; // body Y offset
  const gravity = 9.0;

  // forward/back input
  let userAccel = 0;
  if (controls.forward) userAccel += accel;
  if (controls.back) userAccel -= brake;

  // compute forward direction
  const forward = new THREE.Vector3(Math.sin(state.rotY), 0, Math.cos(state.rotY));

  // slope effect: sample small distance ahead to estimate gradient
  let slopeAccel = 0;
  if (typeof world?.getHeight === 'function') {
    const sampleDist = 0.6;
    const aheadX = state.pos.x + forward.x * sampleDist;
    const aheadZ = state.pos.z + forward.z * sampleDist;
    const h0 = world.getHeight(state.pos.x, state.pos.z);
    const h1 = world.getHeight(aheadX, aheadZ);
    const dh = h1 - h0;
    const slope = dh / sampleDist; // positive = uphill
    // gravity component along forward (approx)
    slopeAccel = -slope * gravity; // uphill reduces speed (negative), downhill adds positive
  }

  // integrate speed: user accel + gravity effect - drag
  state.speed += (userAccel + slopeAccel) * dt;

  // natural drag when no input
  if (!controls.forward && !controls.back) {
    if (state.speed > 0) state.speed = Math.max(0, state.speed - drag * dt);
    if (state.speed < 0) state.speed = Math.min(0, state.speed + drag * dt);
  }

  // clamp speed
  state.speed = Math.max(-4, Math.min(maxSpeed, state.speed));

  // steering scaled by speed magnitude (invert when reversing)
  const turnSpeed = 2.2; // base rad/s
  const steer = (controls.left ? 1 : 0) + (controls.right ? -1 : 0);
  const speedSign = Math.abs(state.speed) > 0.01 ? Math.sign(state.speed) : 1;
  state.rotY += steer * turnSpeed * dt * (0.4 + Math.abs(state.speed) / maxSpeed) * speedSign;

  // integrate position forward in local car direction (XZ plane only)
  state.pos.x += forward.x * state.speed * dt;
  state.pos.z += forward.z * state.speed * dt;

  // stick to terrain: sample world height where available
  try {
    if (typeof world?.getHeight === 'function') {
      const terrainY = world.getHeight(state.pos.x, state.pos.z);
      state.pos.y = terrainY + carBaseHeight;
    } else {
      state.pos.y = carBaseHeight;
    }
  } catch (e) {
    // if world isn't ready, fallback
    state.pos.y = carBaseHeight;
  }
}

let last = performance.now();
function animate() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  updatePhysics(dt);
  car.position.copy(state.pos);
  car.rotation.y = state.rotY;
  // rotate wheels based on forward speed for local car (simple visual)
  try {
    const wheelFactor = 2.8; // visual speed -> wheel rotation factor
    if (car.userData?.wheels && Array.isArray(car.userData.wheels)) {
      for (const wnode of car.userData.wheels) {
        // rotate the wheel mesh (the actual cylinder is child 0 of wheel group)
        if (wnode && wnode.userData && wnode.userData.wheel) {
          wnode.userData.wheel.rotation.x += state.speed * dt * wheelFactor;
          if (wnode.userData.rim) wnode.userData.rim.rotation.x += state.speed * dt * wheelFactor;
        }
      }
    }
  } catch (e) { /* ignore if no wheels */ }

  // maybe update chunks periodically
  lastChunkUpdate += dt * 1000;
  if (lastChunkUpdate > CHUNK_UPDATE_MS) {
    lastChunkUpdate = 0;
    maybeUpdateChunks();
  }

  // animate remote cars toward target positions
  for (const [id, rc] of remoteCars) {
    rc.mesh.position.lerp(rc.targetPos, 0.2);
    // simple rotation lerp
    const a = rc.mesh.rotation.y;
    // normalize angles
    let delta = rc.targetRotY - a;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    rc.mesh.rotation.y = a + delta * 0.2;
    // animate wheels for remote cars as well (based on reported speed)
    try {
      const wheelFactor = 2.8;
      if (rc.mesh.userData?.wheels && Array.isArray(rc.mesh.userData.wheels)) {
        for (const wnode of rc.mesh.userData.wheels) {
          if (wnode && wnode.userData && wnode.userData.wheel) {
            wnode.userData.wheel.rotation.x += rc.speed * dt * wheelFactor;
            if (wnode.userData.rim) wnode.userData.rim.rotation.x += rc.speed * dt * wheelFactor;
          }
        }
      }
    } catch (e) {}
    // update remote name sprite position smoothly
    try {
      if (rc.nameSprite) {
        const target = new THREE.Vector3().copy(rc.mesh.position).add(new THREE.Vector3(0, 2.2, 0));
        rc.nameSprite.position.lerp(target, 0.2);
      }
    } catch (e) {}
  }

  // camera follow (smoothing)
  const desired = new THREE.Vector3().copy(state.pos).add(camOffset.clone().applyAxisAngle(new THREE.Vector3(0,1,0), state.rotY));
  camera.position.lerp(desired, 0.14); // slightly snappier
  camera.lookAt(state.pos.x, state.pos.y + 0.8, state.pos.z);

  // update HUD / info with position and speed
  const pos = state.pos;
  info.textContent = `id=${clientId||'...'} seed=${serverSeed||'...'} pos=${pos.x.toFixed(1)},${pos.z.toFixed(1)}`;
  const speedEl = document.getElementById('speed');
  if (speedEl) speedEl.textContent = `Speed: ${state.speed.toFixed(2)}`;
  
  renderer.render(scene, camera);
  // schedule next frame
  requestAnimationFrame(animate);
}

// connect to server after scene and necessary globals are initialized
connectWS();

// respawn button
const respawnBtn = document.getElementById('respawn');
if (respawnBtn) {
  respawnBtn.addEventListener('click', (e) => {
    // place at start (0,0)
    const sx = 0, sz = 0;
    let sy = 0.35;
    try { if (typeof world?.getHeight === 'function') sy = world.getHeight(sx, sz) + 0.35; } catch(e){}
    state.pos.set(sx, sy, sz);
    state.speed = 0;
    // move camera immediately
    camera.position.set(state.pos.x, state.pos.y + 4, state.pos.z + 8);
  });
}

requestAnimationFrame(animate);

// Chunk manager functions
function chunkCoordFor(x) {
  // x: world coordinate
  if (!world) return 0;
  const cells = world.options.chunkSize;
  const spacing = world.options.spacing;
  return Math.floor(x / (cells * spacing));
}

function makeChunkMesh(chunkX, chunkZ) {
  const data = world.getChunk(chunkX, chunkZ);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geom.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geom.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function updateChunks() {
  if (!world) return;
  const px = state.pos.x;
  const pz = state.pos.z;
  const cx = chunkCoordFor(px);
  const cz = chunkCoordFor(pz);
  const need = new Set();
  for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
    for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
      const ncx = cx + dx;
      const ncz = cz + dz;
      const key = `${ncx},${ncz}`;
      need.add(key);
      if (!loadedChunks.has(key)) {
        const mesh = makeChunkMesh(ncx, ncz);
        loadedChunks.set(key, { mesh, x: ncx, z: ncz });
        scene.add(mesh);
      }
    }
  }
  // remove far chunks
  for (const [key, obj] of loadedChunks) {
    if (!need.has(key)) {
      scene.remove(obj.mesh);
      if (obj.mesh.geometry) obj.mesh.geometry.dispose();
      if (obj.mesh.material) obj.mesh.material.dispose();
      loadedChunks.delete(key);
    }
  }
}

// call updateChunks when player moves more than spacing threshold
let lastChunkCheck = new THREE.Vector2(Infinity, Infinity);
function maybeUpdateChunks() {
  if (!world) return;
  const cells = world.options.chunkSize;
  const spacing = world.options.spacing;
  const px = state.pos.x;
  const pz = state.pos.z;
  const cx = chunkCoordFor(px);
  const cz = chunkCoordFor(pz);
  if (lastChunkCheck.x === cx && lastChunkCheck.y === cz) return;
  lastChunkCheck.set(cx, cz);
  updateChunks();
}

// integrate chunk update into animate loop by calling maybeUpdateChunks() at interval
let lastChunkUpdate = 0;
const CHUNK_UPDATE_MS = 300;

// keyboard handlers
window.addEventListener('keydown', (e) => {
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) e.preventDefault();
  if (e.key === 'ArrowUp' || e.key === 'w') controls.forward = true;
  if (e.key === 'ArrowDown' || e.key === 's') controls.back = true;
  if (e.key === 'ArrowLeft' || e.key === 'a') controls.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd') controls.right = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'w') controls.forward = false;
  if (e.key === 'ArrowDown' || e.key === 's') controls.back = false;
  if (e.key === 'ArrowLeft' || e.key === 'a') controls.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd') controls.right = false;
});

// touch UI buttons
function bindBtn(id, keyName) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); controls[keyName] = true; });
  window.addEventListener('pointerup', (e) => { controls[keyName] = false; });
}
bindBtn('up','forward');
bindBtn('down','back');
bindBtn('left','left');
bindBtn('right','right');

// prevent page scrolling when using arrows
window.addEventListener('keydown', (e) => {
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
});

// expose state for debugging
window.__SIM_STATE = state;
