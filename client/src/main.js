import * as THREE from 'three';

const info = document.getElementById('info');

// WebSocket connection to server (dev server assumes ws on localhost:3000)
const WS_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'ws://localhost:3000' : `wss://${location.host}`;
let clientId = null;
let serverSeed = null;

let wsClient = null;
const remoteCars = new Map(); // id -> { mesh, targetPos: Vector3, targetRotY, speed }

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
      } else if (msg.type === 'update') {
        // update other players
        for (const p of msg.players) {
          if (p.id === clientId) continue; // skip self
          let rc = remoteCars.get(p.id);
          if (!rc) {
            // create remote car mesh (use same low-poly model with different color)
            const g = createCarMesh(0x3366ff);
            scene.add(g);
            rc = { mesh: g, targetPos: new THREE.Vector3(), targetRotY: 0, speed: 0 };
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
        }
      } else if (msg.type === 'leave') {
        const id = msg.id;
        const rc = remoteCars.get(id);
        if (rc) {
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
      speed: state.speed
    };
    wsClient.send(JSON.stringify(msg));
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

// create a low-poly car procedurally
function createCarMesh(color = 0xff3333) {
  const group = new THREE.Group();
  // body
  const bodyMat = new THREE.MeshStandardMaterial({ color: color, flatShading: true });
  const bodyGeo = new THREE.BoxGeometry(1.6, 0.4, 0.9);
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.position.y = 0.3;
  group.add(bodyMesh);
  // cabin (slightly lighter tint)
  const cabinColor = typeof color === 'number' ? (color + 0x333333) & 0xffffff : 0xff6666;
  const cabinMat = new THREE.MeshStandardMaterial({ color: cabinColor, flatShading: true });
  const cabinGeo = new THREE.BoxGeometry(0.9, 0.35, 0.7);
  const cabin = new THREE.Mesh(cabinGeo, cabinMat);
  cabin.position.set(0, 0.55, -0.05);
  group.add(cabin);
  // wheels (simple cylinders)
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 6);
  function makeWheel(x, z) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.12, z);
    return w;
  }
  group.add(makeWheel(0.7, 0.35));
  group.add(makeWheel(-0.7, 0.35));
  group.add(makeWheel(0.7, -0.35));
  group.add(makeWheel(-0.7, -0.35));
  return group;
}

const car = createCarMesh(0xff3333);
scene.add(car);

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
