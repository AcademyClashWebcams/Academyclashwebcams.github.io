const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Map(clientId -> { ws, name })
const rooms = new Map();
// roomId -> { 1: {br,co,sa,hu,mir}, 2: {br,co,sa,hu,mir} }
const overlayFilters = new Map();
// roomId -> { expiresAt: timestamp }
const roomMeta = new Map();

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function broadcast(room, senderId, message) {
  room.forEach((client, id) => {
    if (id !== senderId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

wss.on('connection', (ws) => {
  const clientId = generateId();
  let roomId = null;

  ws.send(JSON.stringify({ type: 'id', id: clientId }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        roomId = msg.room;
        const name = msg.name || 'Anon';

        // Check if room has expired
        if (roomMeta.has(roomId) && roomMeta.get(roomId).expiresAt <= Date.now()) {
          ws.send(JSON.stringify({ type: 'room-expired' }));
          return;
        }

        const isNew = !rooms.has(roomId);
        if (isNew) rooms.set(roomId, new Map());
        const room = rooms.get(roomId);

        // Set expiry on first join (room creation)
        if (isNew && msg.expiry) {
          const minutes = Math.min(Math.max(1, parseInt(msg.expiry) || 60), 20 * 24 * 60);
          roomMeta.set(roomId, { expiresAt: Date.now() + minutes * 60 * 1000 });
          console.log(`[${roomId}] expires in ${minutes} min (${new Date(roomMeta.get(roomId).expiresAt).toLocaleString()})`);
        }

        // Pošli novému klientovi seznam existujících peerů + jejich jména
        const existing = [];
        room.forEach((client, id) => {
          existing.push({ id, name: client.name });
        });
        ws.send(JSON.stringify({ type: 'peers', peers: existing }));

        // Informuj ostatní o novém klientovi
        broadcast(room, clientId, { type: 'peer-joined', id: clientId, name });

        room.set(clientId, { ws, name });
        console.log(`[${roomId}] +${name} (${clientId}) | celkem: ${room.size}`);

        // Pošli info o expiraci roomky
        if (roomMeta.has(roomId)) {
          ws.send(JSON.stringify({ type: 'room-info', expiresAt: roomMeta.get(roomId).expiresAt }));
        }

        // Pokud se připojuje overlay, pošli mu uložený stav filtrů
        if (name === '__overlay__' && overlayFilters.has(roomId)) {
          const saved = overlayFilters.get(roomId);
          Object.keys(saved).forEach(cam => {
            ws.send(JSON.stringify({ type: 'overlay-sync', cam: Number(cam), settings: saved[cam] }));
          });
        }
        break;
      }

      case 'signal': {
        const room = rooms.get(roomId);
        if (!room) return;
        const target = room.get(msg.to);
        if (target && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify({
            type: 'signal',
            from: clientId,
            signal: msg.signal
          }));
        }
        break;
      }

      case 'name-change': {
        const room = rooms.get(roomId);
        if (!room || !room.has(clientId)) return;
        room.get(clientId).name = msg.name;
        broadcast(room, clientId, { type: 'name-change', id: clientId, name: msg.name });
        break;
      }

      // Synchronizace filtrů (z overlay vieweru do OBS tabu a dalších)
      case 'overlay-sync': {
        const room = rooms.get(roomId);
        if (!room) return;
        // Ulož stav filtrů pro pozdější připojení
        if (!overlayFilters.has(roomId)) overlayFilters.set(roomId, {});
        overlayFilters.get(roomId)[msg.cam] = msg.settings;
        broadcast(room, clientId, { type: 'overlay-sync', cam: msg.cam, settings: msg.settings });
        break;
      }

    }
  });

  ws.on('close', () => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    room.delete(clientId);
    broadcast(room, clientId, { type: 'peer-left', id: clientId });
    if (room.size === 0) { rooms.delete(roomId); overlayFilters.delete(roomId); roomMeta.delete(roomId); }
    console.log(`[${roomId}] -${clientId} | zbývá: ${room.size}`);
  });

  ws.on('error', (err) => console.error('WS chyba:', err.message));
});

// Periodicky kontroluj expiraci roomek (každých 30s)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, meta] of roomMeta) {
    if (meta.expiresAt <= now && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      // Oznam všem klientům v roomce
      room.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'room-expired' }));
          client.ws.close();
        }
      });
      rooms.delete(roomId);
      overlayFilters.delete(roomId);
      roomMeta.delete(roomId);
      console.log(`[${roomId}] expired & cleaned up`);
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  WebRTC Studio běží na http://localhost:${PORT}\n`);
});
