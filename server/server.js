const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// serve built client if exists
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// persistent seed for the world
const SEED = Math.floor(Math.random() * 0x7fffffff);
console.log('Server seed:', SEED);

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

// In-memory state storage for players
const clients = new Map(); // id -> { ws, lastState }
const states = new Map(); // id -> lastState

wss.on('connection', (ws, req) => {
  const id = makeId();
  ws._clientId = id;
  clients.set(id, { ws, lastState: null });
  console.log('client connected', id, req.socket.remoteAddress);
  // send init
  ws.send(JSON.stringify({ type: 'init', id, seed: SEED }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (!data || !data.type) return;

      if (data.type === 'state') {
        // sanitize and store latest state for broadcasting (including optional skin and name metadata)
        // sanitize name: string, trim, remove control chars, limit to 10 chars
        let name = null;
        if (typeof data.name !== 'undefined' && data.name !== null) {
          try {
            name = String(data.name).replace(/[\r\n\t\0\x0B]/g, ' ').trim().slice(0, 10);
          } catch (e) { name = null; }
        }
        states.set(id, {
          id,
          t: data.t || Date.now(),
          p: data.p || [0,0,0],
          rotY: typeof data.rotY === 'number' ? data.rotY : 0,
          speed: typeof data.speed === 'number' ? data.speed : 0,
          skin: typeof data.skin !== 'undefined' ? data.skin : null,
          name: name
        });
      } else if (data.type === 'rename' || data.type === 'name_update') {
        // explicit rename request: sanitize and update stored state, then broadcast immediately
        let name = null;
        if (typeof data.name !== 'undefined' && data.name !== null) {
          try {
            name = String(data.name).replace(/[\r\n\t\0\x0B]/g, ' ').trim().slice(0, 10);
          } catch (e) { name = null; }
        }
        const prev = states.get(id) || { id, p: [0,0,0], rotY: 0, speed: 0, t: Date.now(), skin: null };
        prev.name = name;
        prev.t = Date.now();
        states.set(id, prev);
        // broadcast immediately
        broadcastStates();
      }
    } catch (e) {
      console.warn('failed to parse message from', id, e);
    }
  });

  ws.on('close', () => {
    console.log('client disconnected', id);
    clients.delete(id);
    states.delete(id);
    // broadcast leave to others
    const leaveMsg = JSON.stringify({ type: 'leave', id });
    for (const [otherId, obj] of clients) {
      try { obj.ws.send(leaveMsg); } catch (e) { }
    }
  });
});

// Broadcast helper: aggregate current states and send update to all clients
function broadcastStates() {
  if (states.size === 0) return;
  const players = [];
  for (const [id, s] of states) {
    players.push({ id: s.id, p: s.p, rotY: s.rotY, speed: s.speed, t: s.t, skin: s.skin, name: s.name });
  }
  const msg = JSON.stringify({ type: 'update', players });
  for (const [id, obj] of clients) {
    try { obj.ws.send(msg); } catch (e) { }
  }
}

// Broadcast loop: aggregate and send player states at ~15Hz
const TICK_MS = 66;
setInterval(() => {
  broadcastStates();
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`HTTP+WS server listening on port ${PORT}`);
});
