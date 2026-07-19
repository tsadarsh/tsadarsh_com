tsadarsh.com — Car Simulator

Purpose
-------
This document records the architecture, design decisions, developer usage, data formats, and a detailed changelog for the tsadarsh.com multiplayer low-poly car simulator. It is intended for developers and AI agents who need to understand the repository structure, runtime behaviour, and how to extend the project.

Table of contents
-----------------
- Overview
- High-level architecture
- Key components and important files
- WebSocket protocol & runtime state
- Procedural world API (world generation)
- Car design: JSON schema and runtime integration
- Skinning & customization (color picker and network sync)
- How to replace the car model (workflow)
- Running locally (dev) and building for production
- Deployment notes and Render domain/TLS troubleshooting
- Performance considerations
- Testing checklist
- Future work and roadmap
- Changelog

Overview
--------
A lightweight multiplayer car simulator that runs in the browser (three.js client) and uses a Node/Express server with WebSocket (ws) to relay player states. Terrain is procedurally generated in deterministic chunks so all players share the same world given a server seed. Each connecting user gets a unique car. Cars are rendered locally and remote players are visible to each other.

High-level architecture
-----------------------
- Client (client/src)
  - Three.js scene and renderer (single-page app)
  - Procedural terrain chunk loader using deterministic seed
  - Player kinematic model (simple acceleration, steering, slope handling)
  - Car rendering derived from a design JSON schema (car.design.json)
  - UI overlays: speedometer, respawn, color picker
  - WebSocket client that sends local state ~15Hz and receives aggregated player states
- Server (server/server.js)
  - Express serves static files from dist (production) and SPA fallback
  - ws-based WebSocket server maintains connected clients and latest states
  - Broadcast loop aggregates and broadcasts player states at ~15Hz

Key components and important files
---------------------------------
- package.json
  - scripts: dev (vite client), build, start (node server/server.js)
- server/server.js
  - Express static hosting and SPA fallback
  - WebSocket server logic and state relay
- client/index.html
  - HUD layout, controls, and color picker UI
- client/src/main.js
  - Main client app: scene setup, terrain/chunk manager, car creation & animation, networking, UI wiring
- client/src/world/worldAPI.js
  - Deterministic procedural chunk generator and height sampling API
- client/src/car.design.json
  - The current JSON car design (lowpoly-sports-car) used to procedurally generate a nicer car model in runtime
- client/src/car.design.json (imported as carDesign in main.js)
- client/src/car.design.json schema (see section below)

WebSocket protocol & runtime state
---------------------------------
All messages are JSON. Two primary message directions:

1) Server -> Client
- init
  - { type: 'init', id: <assignedClientId>, seed: <serverSeed> }
  - Sent once on new connection; client uses seed to rebuild deterministic world
- update
  - { type: 'update', players: [ { id, p: [x,y,z], rotY, speed, t, skin? }, ... ] }
  - Broadcast at regular tick (≈15Hz). Each player entry contains the last reported state. skin is optional and may be a hex string (e.g. "#ff33aa").
- leave
  - { type: 'leave', id }
  - Indicates a player disconnected; client should remove remote avatar

2) Client -> Server
- state
  - { type: 'state', id, t, p: [x,y,z], rotY, speed, skin? }
  - Sent by each client periodically (≈15Hz). skin is optional — used for broadcasting tint/skin metadata.

Notes for implementers
- The server stores the last state for each connected client in-memory and broadcasts aggregated updates. There is no authoritative physics on server — clients trust local physics.
- skin was added to the state payload so small skin metadata (hex color) can be propagated.

Procedural world API (world generation)
---------------------------------------
- File: client/src/world/worldAPI.js
- Purpose: deterministic chunk-based terrain generator. Given a seed and chunk coordinates (cx, cz), it generates a heightmap and mesh attributes so the client can create BufferGeometry with vertex colors for shading.
- API (client-usage):
  - createWorld(seed, options) -> returns world object with methods
  - world.getChunk(cx, cz) -> returns vertex/position/index buffers for THREE.BufferGeometry
  - world.getHeight(x, z) -> sample scalar height at world coordinates
- Design decisions:
  - Deterministic by seed so all clients produce identical terrain without server-side storage.
  - Chunk sizes and spacing configurable via world options.
  - Color ramp + slope shading applied at vertex colors for readability.

Car design: JSON schema and runtime integration
----------------------------------------------
The project uses a design-driven approach: car design is authored as JSON (client/src/car.design.json). This allows swapping models without changing code.

Accepted part types
- box: params { sx, sy, sz }
- cylinder: params { radiusTop, radiusBottom, height, radialSegments, axis } (axis: 'x'|'y'|'z')
- plane: params { width, height }
- sphere: params { radius, widthSegments, heightSegments }
- custom: params { positions: [...], indices: [...], normals?: [...], uvs?: [...] }

Part fields
- id: unique string
- type: one of the accepted types
- params: type-specific parameters
- pos: [x,y,z] (optional)
- rot: [x,y,z] Euler radians (optional)
- scale: [x,y,z] (optional)
- material: materialKey referencing design.materials
- meta: arbitrary object (e.g., { role: 'wheel', steer: true })

Material fields (design.materials)
- color: '#rrggbb' or numeric
- metalness: number 0..1
- roughness: number 0..1
- flatShading: boolean
- transparent: boolean
- opacity: number 0..1
- tintable: boolean (if true the color picker will change this material's color at runtime)

Runtime behavior
- The client imports car.design.json and calls buildCarFromDesign(design, tintColor) to create a THREE.Group.
- Wheels are detected via meta.role == 'wheel' and wrapped into Groups with userData.wheel references to allow rotation animation.
- Materials marked tintable are recorded so applyTintToMesh(group, color) can apply the new color to all tintable materials.
- createCarMesh(color) is the constructor used both for local and remote cars. The color passed is applied to tintable materials if present.
- Remote car instances are created using skin reported from the server if available.

Skinning & customization (color picker and network sync)
--------------------------------------------------------
- UI: color input (type=color) with id="colorPicker" added to client/index.html HUD.
- Persistence: chosen color saved to localStorage at key 'car_color'.
- Local runtime: applyTintToMesh applies the color to tintable materials on the local car instance.
- Networking: localSkin is included in the periodic state message (skin: '#rrggbb'). The server stores skin in the states map and broadcasts it to others.
- Remote clients apply the reported skin color to remote car instances when the update arrives.

How to replace the car model (workflow)
---------------------------------------
1) Create or edit a JSON file matching the schema. Place it at client/src/car.design.json or another path and update import in main.js.
2) Ensure the material intended for tinting has "tintable": true in the design JSON.
3) Name wheel parts as wheel_fl, wheel_fr, wheel_rl, wheel_rr or include meta.role: 'wheel' so the loader detects them for animation.
4) Reload clients (or implement a "reload-model" broadcast) to have new clients use the replacement design.

Running locally (dev) and building for production
-------------------------------------------------
Prereqs: Node.js (recommended 18+), npm/yarn.

Dev:
- npm run dev  (runs vite client)
- Start server separately if testing WebSocket relay with production static files: node server/server.js

Build:
- npm run build
  - runs: cd client && rm -rf ../dist && vite build --outDir ../dist
- Start server with: npm start  (node server/server.js)
- Server serves files from dist/ and listens on PORT (default 3000).

Deployment notes and Render domain/TLS troubleshooting
---------------------------------------------------
- When deploying to Render (or similar), ensure static build outputs to the path server expects (dist/) and server static root is configured correctly.
- Custom domain TLS issues observed when DNS is proxied via Wix/Cloudflare. Render requires DNS records that resolve directly to Render's target (CNAME for www -> <service>.onrender.com and A records for apex pointing to Render IPs) and should not be proxied through an extra CDN/proxy layer that blocks TLS issuance.
- If certificate provisioning fails:
  1) Verify nameservers and DNS records (remove Wix forwarding and proxying for the domain entries pointing to Render).
  2) Ensure www is a CNAME to the Render service and apex is A records to Render's IPs.
  3) Wait for propagation and re-try certificate issuance in Render.

Performance considerations and optimizations
-------------------------------------------
- Keep car meshes low-poly (a few hundred to a few thousand tris) for quick load and rendering on mobile.
- Use shared model creation for multiple remote players (clone a single built Group where possible) to minimize geometry/material duplicates.
- Textures: currently none used; if you add textures, keep them small (128–512 px) or use compressed formats (KTX2/Basis) with appropriate loaders.
- Consider Draco compression and KTX2 for glTF assets if you adopt external models.
- Limit shadow usage on low-end devices; keep renderer.shadowMap disabled by default.

Testing checklist
-----------------
- Single-player local: car spawns, can accelerate/brake/steer, sticks to terrain heights when traversing hills and valleys.
- Multi-tab multiplayer: opening a second tab creates a new player and both players can see each other in the same world (positions, rotations, colors should sync).
- Car customization: changing the color picker updates the local car and the remote car color in other tabs.
- Terrain chunking: moving around loads/unloads chunks without memory leaks. Watch for disposed geometries and materials.
- Render/test on mobile browser to confirm performance and touch controls work (on-screen arrow buttons present).

Future work and roadmap
-----------------------
- Front-wheel steering visuals: animate front wheels' steering angle from input (meta.steer in design JSON is already present).
- Replace JSON design with glTF models for better visuals; add GLTFLoader, DRACOLoader for Draco-compressed assets.
- Decal system for logos and multi-layer paint; mask textures or projected decals.
- Server-side authoritative physics for cheat prevention (optional, adds complexity).
- Player accounts & persistent skins/ownership (server-side persistence and authentication).
- LOD for cars and terrain for better distant rendering performance.

Changelog
---------
This changelog summarizes major changes and the reasoning behind them. It can be used by agents for traceability.

- Initial scaffold (Phase 0/1)
  - Created basic project scaffolding with Vite-based client and Express+ws server. Implemented simple box car and WebSocket connection.
  - Decision: keep client lightweight, deterministic world generation on client using seed.

- Multiplayer state relay
  - Implemented server in-memory state storage and 15Hz broadcast loop.
  - Clients send periodic state messages (~15Hz). Decision: server relays states only (no authoritative physics) to simplify early multiplayer.

- Procedural terrain (Phase 2)
  - Added client/src/world/worldAPI.js for deterministic chunk-by-chunk terrain generation and height sampling.
  - Implemented chunk loading/unloading and vertex color ramps + slope shading for readability.

- Terrain-following cars
  - Car physics updated to sample world.getHeight(x,z) and adjust Y position so cars stick to terrain.

- Steering fix
  - Corrected steering inversion when reversing so left+reverse turns left (expected behaviour).

- Better car visuals (Phase 3)
  - Initially added a procedural low-poly car created from primitives to replace the cuboid. Wheel animation added.
  - Decision: keep procedural generator for instant iteration without external assets.

- Design-driven car model via JSON
  - User supplied car.design.json (lowpoly-sports-car). Implemented buildCarFromDesign to construct THREE.Group from JSON parts/materials.
  - Outcome: world vs car decoupled. Replacing car design JSON changes runtime model without code edits.

- Skinning & customization
  - Added color picker (client/index.html) and applyTintToMesh to update tintable materials.
  - Persist color in localStorage and include tint (skin) in WebSocket state messages.
  - Server updated to accept skin in incoming state and broadcasts skin in update messages.
  - Decision: keep skin metadata lightweight (hex string) and non-authoritative (client-driven). Server only relays.

- Deployment fixes
  - Adjusted build script to be compatible with Vite v5 and Render's expectations (build from client into root dist/ directory).
  - Added SPA fallback route in Express to serve index.html on unknown paths.
  - DNS/TLS troubleshooting notes added: Render requires direct DNS pointing; Wix forwarding/proxying can block TLS issuance.

- Minor improvements
  - Wheel rotation for remote players implemented (based on reported speed) to improve visual coherence.
  - Remote car instantiation uses reported skin color or a default if not provided.

Notes about decisions and tradeoffs
----------------------------------
- Client-side deterministic terrain: pros — no server cost for terrain, consistent world across clients. Cons — any non-deterministic client will diverge.
- Non-authoritative server: simple and fast to iterate; not secure against cheating. For a casual demo this tradeoff is acceptable.
- JSON car design vs glTF: JSON lets rapid iteration and LLM-driven design; glTF yields better visuals and artist tooling. The system supports swapping later with minimal code changes.
- Textures avoided so far to keep bandwidth low and startup fast. Adding textures later will require CDN/hosting and loader code.

Where to look in the repo
------------------------
- client/src/main.js — main client logic, scene, networking, car building, UI
- client/src/car.design.json — current car design JSON
- client/src/world/worldAPI.js — terrain generator and chunk mesh builder
- server/server.js — static serving and WebSocket relay
- client/index.html — HUD and controls, now includes color picker
- package.json — build and start scripts

If you want a machine-readable summary for an AI agent, I can also generate a JSON metadata file listing key paths, entry points, message formats, and the car schema programmatically.

---

End of document.
