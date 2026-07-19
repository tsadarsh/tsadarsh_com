Project: tsadarsh.com — Lightweight Multiplayer Procedural Low-Poly Car Simulator
Date: 2026-07-17
Author: Copilot-runner plan

Purpose
-------
This plan documents a step-by-step roadmap to build a lightweight, multiplayer, browser-based low-poly car simulator served from tsadarsh.com. Key requirements: per-user car spawn/despawn, keyboard + on-screen controls, procedural "infinite" world (chunked), decoupled world-generation subsystem, visible other players' cars, fast load and low bandwidth.

High-level MVP Goals
--------------------
- Fast client load (< 2s on warm cache / < 1.5 MB JS gzipped target for MVP where possible)
- Infinite procedural off-road rolling-hills green pasture terrain (client-generated chunks deterministically via a shared seed)
- One independent car per connected user; cars visible to all users in the same world
- Basic driving controls (WASD / arrow keys, on-screen arrows for touch)
- Lightweight networking: Node.js WebSocket server for state sync
- Decoupled world generation engine (pluggable module API) so different world types can be added later
- Simple, deterministic physics/kinematics (kinematic car motion; no heavy physics engine for first iteration)

Tech choices (rationale)
-------------------------
- Client rendering: Three.js (widely-used, small + tree-shakable builds; easy to get WebGL + meshes + simple materials)
- Procedural noise: simplex-noise or improved-perlin JS (fast, compact) for heightmap generation
- Networking: Node.js + ws (lightweight) or socket.io if convenience needed; initial plan uses ws to keep it minimal
- Server: Node.js + Express for static hosting (or static files served by CDN/host) and ws for realtime state
- Build: Vite (fast dev server and small bundles) or Rollup/esbuild for building; prefer Vite for quick iteration
- Models: Low-poly car as small glTF or procedurally-generated mesh (box + wheels) to avoid asset downloads. Keep geometry simple to reduce size.
- Deployment: Static client assets served from CDN/hosting (Vercel/Netlify) or same Node server for integrated deploy. Use Cloudflare/Let's Encrypt for TLS and caching.

System Architecture
-------------------
- Client (browser): renders scene, generates terrain chunks from world module using shared seed, spawns local car, sends local input/state to server, receives other players' states and updates their cars with interpolation.
- Server (Node): accepts WebSocket connections, assigns unique client IDs, issues world seed and world parameters, relays periodic position updates, performs lightweight presence management (join/leave), can optionally validate/sanitize state but authoritative physics not needed for MVP.
- World module interface (decoupled): a simple API: init(seed, params), getChunk(chunkX, chunkZ), disposeChunk(chunkX, chunkZ). Each chunk returns mesh data or heightmap that client converts to mesh.

Message protocol (compact binary/JSON guidelines)
------------------------------------------------
- Use compact JSON for simplicity, consider binary (msgpack) later.
- On connect: { type: 'join', name?: string }
- Server -> client: { type: 'init', id: '<clientId>', seed: <int>, worldParams: {...}, tickRate: 20 }
- Client -> server (periodic, ~10-20Hz): { type: 'state', id: '<clientId>', t: <timestamp_ms>, p: [x,y,z], r: [x,y,z], v: [vx,vy,vz], inputHash?: <small> }
- Server -> clients (batched, ~10-20Hz): { type: 'update', players: [{ id, p, r, v, lastT }], remove: [id,...] }
- On disconnect: server broadcasts { type: 'leave', id }
- Keep messages minimal: quantize positions to 2 decimal or send integers (fixed point) to reduce size.

Networking decisions & optimizations
-----------------------------------
- Tick rate: 10-20 Hz (tradeoff between smoothness and bandwidth)
- Client-side interpolation/extrapolation for other players to hide latency
- Interest management for scale: for MVP broadcast to all clients; later restrict by distance (nearby only)
- Delta compression and quantization after MVP

World generation (decoupled design)
-----------------------------------
API (JavaScript module) - example surface:
- export function createWorld(seed, params)
  - returns { getChunk(chunkX, chunkZ): { positions: Float32Array, normals?, colors? }, releaseChunk(chunkX, chunkZ) }

Chunking strategy
- Fixed-size square chunks (e.g., 64x64 vertices, world units per vertex configurable)
- Chunk coordinate derived from player position (Math.floor(x / (chunkSize * unitSize)))
- Clients generate chunks deterministically using seed + chunkX + chunkZ so all clients produce identical terrain
- Seam stitching: share edges or use consistent noise sampling so edges match exactly

Terrain appearance for first iteration
- Pasture: low-amplitude rolling hills using octave noise (simplex) multiplied by gentle falloff
- Color by height (vertex colors) — no large textures to keep weight low
- Add some low-poly rocks/trees as procedurally placed simple meshes occasionally

Client responsibilities
-----------------------
1. Bootstrapping
  - Load minimal bundle and boot script (index.html -> main.js)
  - Connect WebSocket, receive init seed and client id
  - Initialize Three.js renderer, camera, basic lights
2. World loading
  - Maintain visible chunk set centered on player (e.g., radius 2-3 chunks depending on LOD)
  - Generate chunk meshes via world module and add to scene
  - Release far-away chunks
3. Player car
  - Local car: simple low-poly model built in code or tiny glTF (<= 20KB). Attach camera to follow behind with smoothing.
  - Controls: keyboard (WASD/arrows), on-screen UI arrows for touch (simple HTML overlay). Prevent default browser scrolling when using arrows.
  - Kinematics: apply acceleration/brake, yaw rotation, simple friction. No wheel simulation for MVP.
4. Multiplayer
  - Send local state (position, rotation, velocity) at tick rate to server
  - Receive other players' state updates and create/ despawn remote car objects as needed
  - Interpolate remote cars between received states
5. Lifecycle
  - On unload (page close), client WebSocket closes and server broadcasts leave (server cleans up and informs other clients)

Server responsibilities
-----------------------
1. Connection management
  - Accept WebSocket connections, assign uuid client IDs
  - Send init message with server seed and server time/tickRate
2. State relay
  - Receive state messages and broadcast to other clients (optionally rate-limit clients)
  - Keep small in-memory map of client states for last known info
3. Presence
  - Broadcast join/leave events
4. Persistence/rooms
  - For MVP keep one global world/room. Later support rooms or sharding by interest management.
5. Security
  - Validate message shapes, prevent extremely large payloads, limit broadcast rate to avoid abuse

File layout (suggested)
-----------------------
- /client
  - index.html
  - src/main.ts (or .js)
  - src/renderer/scene.ts
  - src/controls/keyboard.ts
  - src/controls/touchUI.ts
  - src/world/worldAPI.ts (adapter that uses chosen noise lib)
  - src/network/wsClient.ts
  - src/entities/car.ts
  - assets/ (tiny models if any)
  - vite.config.js
- /server
  - server.js (express + ws)
  - package.json
  - src/net/protocol.js
- /deploy
  - docs for DNS, SSL, hosting
- README.md

Concrete step-by-step implementation plan
-----------------------------------------
Phase 0 — Prep (1-2 days)
1. Create repo skeleton with client and server folders (Vite + Node minimal). (Create files & package.json)
2. Setup Vite dev server and basic build script; setup Node server that can serve static built client and host ws.
3. Choose noise library (simplex-noise) and three.js version; add to package.json

Phase 1 — Minimal client + server loop (2-4 days)
1. Client: minimal Three.js setup showing a static flat ground plane and camera. (Task: Render loop, responsive canvas)
2. Server: basic ws server that accepts connections and assigns client ids; returns a static seed on connect. Send a heartbeat init: {type:'init', id, seed}
3. Client connects, receives seed and logs it. No world generation yet.
4. Add simple on-screen controls UI (just arrows) and keyboard handler; show inputs in UI for debugging.

Phase 2 — Procedural terrain (3-6 days)
1. Implement world module with API createWorld(seed, params) and getChunk(chunkX, chunkZ). Use simplex noise to produce heights and vertex colors.
2. Client: chunk manager that loads chunks around player position (configurable radius), builds Three.js BufferGeometry for each chunk, adds to scene.
3. Ensure seams match (consistent sampling) and chunk release works.
4. Add small decorative low-poly rocks/occasional meshes procedurally placed.

Phase 3 — Local car & controls + local camera (2-3 days)
1. Implement a low-poly car (procedural or tiny glTF). Place it at spawn position derived from first chunk height.
2. Add kinematic driving model: acceleration, top speed, steering with yaw, basic friction and slope handling.
3. Follow camera with smoothing/back offset.
4. Add UI overlays (speedometer text, respawn button)

Phase 4 — Multiplayer basics (3-5 days)
1. Client: send periodic state messages to server with position/rotation/velocity at ~10-20Hz.
2. Server: accept state messages and broadcast aggregated updates to all clients on a server tick (same tick rate).
3. Client: spawn remote car objects when new player info arrives; interpolate/extrapolate their transforms.
4. Test with multiple browser windows locally; ensure join/leave works and remote cars despawn on disconnect.

Phase 5 — Performance & bandwidth optimizations (2-4 days)
1. Quantize and pack state messages; test lower tick rates with interpolation.
2. Implement simple distance-based interest management on client (in rendering) and later on server.
3. Keep bundle sizes low: minimize dependencies, lazy-load modules (e.g., only load world module after initial connect), compress assets.

Phase 6 — Deployment & domain setup (1-2 days)
1. Choose hosting approach. For quick iteration host server on a small VPS / DigitalOcean with Node process and reverse proxy (nginx) to serve static client and TLS. Alternatively, host client as static on Vercel/Netlify and host WebSocket server on a small Heroku/Render instance or same VPS.
2. Configure DNS A/AAAA records for tsadarsh.com to chosen host. Setup TLS (Let's Encrypt or Cloudflare).
3. Deploy build, run server, smoke test.

Phase 7 — Polish & future work (ongoing)
- Add room/scale: shard into multiple rooms or add interest management to support many players
- Add more world types by implementing new world modules that comply with the world API
- Add vehicle customization, obstacles, simple physics, or better visuals
- Add persistence (player profiles), scoreboard, chat

Testing plan
------------
- Unit test world module height outputs at chunk boundaries to ensure continuity.
- Integration test: two local clients connecting to server and verifying position sync and despawn.
- Performance testing: measure memory and frame times with chunk radius growth; target 60 FPS on modern mobile with reduced settings.
- Network test: measure bytes/sec per client at a variety of tick rates (10, 15, 20 Hz).

Deployment checklist (before making site public)
------------------------------------------------
- TLS certificate installed and enforcing HTTPS
- Domain A record(s) pointing to host & WebSocket endpoint reachable wss://
- Basic abuse-rate limiting and message size limits on server
- Build pipeline / CI: test build, run lint, run smoke integration locally

Minimum deliverable for "first iteration" (MVP)
------------------------------------------------
- tsadarsh.com serves a page that connects to ws server, gets seed, generates nearby terrain chunks, spawns a local low-poly car, allows driving with keyboard/on-screen arrows, and shows other connected clients' cars moving around. Car despawns on disconnect.

Risks & mitigations
-------------------
- Bandwidth & latency: mitigate via low tick rates, quantization, interpolation, and interest management
- CPU load for client chunk generation: mitigate by using modest chunk sizes and LOD (reduce vertex density with distance)
- Cross-browser compatibility: test Chrome, Safari (esp. on iOS), and fallback to 2D if WebGL is unsupported

Next actionable steps (immediate)
--------------------------------
1. Initialize git repo and project skeleton with package.json and Vite + Node server files
2. Implement server init message (seed generator) and quick client that connects and logs seed
3. Implement Three.js boot scene and basic keyboard + UI controls

If this plan looks good, the next task is to scaffold the repository (create package.json, vite project, and server.js) and implement Phase 1 (minimal client + server connect). If a timeline/priority changes are preferred, indicate which features to move earlier (e.g., prefer mobile-first, or prioritize bandwidth optimizations first).

Appendix A — Example message sizes & estimates (MVP)
--------------------------------------------------
- State message (JSON, minimal): ~80 bytes per client per tick (id + pos + rot + timestamp). At 10 Hz => 800 B/s per client upstream. Broadcast to N clients => server outbound scales O(N^2) without interest management. For small scale/poc this is fine; for larger scale add interest management.

Appendix B — Minimal seed generation approach
---------------------------------------------
- Use a 32-bit integer seed generated by server on first start (Math.floor(Math.random()*2**31)). Send to clients on connect. All clients use the same seed so terrain is consistent.

Appendix C — World module pseudocode
-------------------------------------
- createWorld(seed, params) {
    const noise = new SimplexNoise(seed);
    return {
      getChunk(cx, cz) {
        // sample at consistent grid offsets using (cx,cz) and return Float32 arrays
      },
      releaseChunk(cx, cz) { /* cleanup if needed */ }
    }
  }


End of plan
