const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');
ws.on('open', () => console.log('test client connected'));
ws.on('message', (data) => { console.log('message:', data.toString()); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.error('err', e); process.exit(1); });
