/* ============================================================
   overlay-viewer.js – Academy Clash Overlay logic
   WebRTC viewer + filtr kamer + sync do OBS přes WebSocket
   ============================================================ */

const PARAMS   = new URLSearchParams(window.location.search);
const ROOM_ID  = PARAMS.get('room');
const OBS_MODE = PARAMS.get('obs') === '1';

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// ── SCENE SCALE ─────────────────────────────────────────────
function scaleScene() {
  const scene = document.getElementById('scene');
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const ox = (window.innerWidth  - 1920 * scale) / 2;
  const oy = (window.innerHeight - 1080 * scale) / 2;
  scene.style.transform = 'translate(' + ox + 'px, ' + oy + 'px) scale(' + scale + ')';
}
scaleScene();
window.addEventListener('resize', scaleScene);

if (OBS_MODE) document.documentElement.classList.add('obs-mode');

// ── COLOR PANEL ─────────────────────────────────────────────
function toggleColorPanel() {
  const panel = document.getElementById('color-panel');
  const btn   = document.getElementById('gear-btn');
  if (!panel) return;
  const isOpen = panel.style.display === 'flex';
  panel.style.display = isOpen ? 'none' : 'flex';
  btn.classList.toggle('open', !isOpen);
}

/**
 * Přečte hodnoty sliderů, aplikuje CSS filtr na video
 * a pokud je otevřené WS spojení pošle stav ostatním tabům (OBS).
 */
function updateFilter(n, broadcast) {
  const vid = document.getElementById('cam-video-' + n);
  if (!vid) return;

  const br  = document.getElementById('c' + n + '-brightness').value;
  const co  = document.getElementById('c' + n + '-contrast').value;
  const sa  = document.getElementById('c' + n + '-saturate').value;
  const hu  = document.getElementById('c' + n + '-hue').value;
  const mir = document.getElementById('c' + n + '-mirror').checked;

  document.getElementById('c' + n + '-brightness-val').textContent = br + '%';
  document.getElementById('c' + n + '-contrast-val').textContent   = co + '%';
  document.getElementById('c' + n + '-saturate-val').textContent   = sa + '%';
  document.getElementById('c' + n + '-hue-val').textContent        = hu + '°';

  applyFilterToVideo(vid, { br, co, sa, hu, mir });

  // Pošli stav ostatním tabům (OBS) – broadcast=true jen při manuálním posunu
  if (broadcast !== false && ws && ws.readyState === WebSocket.OPEN && ROOM_ID) {
    ws.send(JSON.stringify({
      type: 'overlay-sync',
      cam: n,
      settings: { br, co, sa, hu, mir }
    }));
  }
}

function applyFilterToVideo(vid, s) {
  vid.style.setProperty('filter',
    'brightness(' + s.br + '%) contrast(' + s.co + '%) saturate(' + s.sa + '%) hue-rotate(' + s.hu + 'deg)',
    'important');
  vid.style.setProperty('transform', s.mir ? 'scaleX(-1)' : 'scaleX(1)', 'important');
}

/** Aplikuje přijatý stav filtru z jiného tabu (OBS příjem) */
function applyRemoteFilter(cam, s) {
  // Nastav slidery vizuálně (pro případ že OBS tab má taky panel)
  ['brightness', 'contrast', 'saturate'].forEach(k => {
    const el = document.getElementById('c' + cam + '-' + k);
    if (el) el.value = s[k] || 100;
  });
  const hueEl    = document.getElementById('c' + cam + '-hue');
  const mirrorEl = document.getElementById('c' + cam + '-mirror');
  if (hueEl)    hueEl.value      = s.hu || 0;
  if (mirrorEl) mirrorEl.checked = s.mir !== false;

  // Aplikuj na video
  const vid = document.getElementById('cam-video-' + cam);
  if (vid) applyFilterToVideo(vid, { br: s.br||100, co: s.co||100, sa: s.sa||100, hu: s.hu||0, mir: s.mir!==false });

  // Aktualizuj popisy
  const bv = document.getElementById('c' + cam + '-brightness-val');
  const cv = document.getElementById('c' + cam + '-contrast-val');
  const sv = document.getElementById('c' + cam + '-saturate-val');
  const hv = document.getElementById('c' + cam + '-hue-val');
  if (bv) bv.textContent = (s.br||100) + '%';
  if (cv) cv.textContent = (s.co||100) + '%';
  if (sv) sv.textContent = (s.sa||100) + '%';
  if (hv) hv.textContent = (s.hu||0)   + '°';
}

function resetCam(n) {
  document.getElementById('c' + n + '-brightness').value = 100;
  document.getElementById('c' + n + '-contrast').value   = 100;
  document.getElementById('c' + n + '-saturate').value   = 100;
  document.getElementById('c' + n + '-hue').value        = 0;
  document.getElementById('c' + n + '-mirror').checked   = true;
  updateFilter(n);  // broadcast reset taky
}

// Inicializuj výchozí filtry po načtení stránky
document.addEventListener('DOMContentLoaded', function () {
  updateFilter(1, false);
  updateFilter(2, false);
});

// ── SWAP CAMS ────────────────────────────────────────────────
function swapCams() {
  const v1 = document.getElementById('cam-video-1');
  const v2 = document.getElementById('cam-video-2');
  const src1 = v1.srcObject;
  const src2 = v2.srcObject;
  const act1 = v1.classList.contains('active');
  const act2 = v2.classList.contains('active');

  v1.srcObject = src2;
  v2.srcObject = src1;
  v1.classList.toggle('active', act2);
  v2.classList.toggle('active', act1);

  const ph1 = document.getElementById('placeholder-1');
  const ph2 = document.getElementById('placeholder-2');
  const ph1vis = ph1 ? ph1.style.display : '';
  if (ph1) ph1.style.display = ph2 ? ph2.style.display : '';
  if (ph2) ph2.style.display = ph1vis;

  if (typeof peerOrder !== 'undefined' && peerOrder.length === 2) {
    var tmp = peerOrder[0]; peerOrder[0] = peerOrder[1]; peerOrder[1] = tmp;
  }
}

// ── WEBRTC VIEWER ────────────────────────────────────────────
if (!ROOM_ID) {
  console.warn('Overlay: žádný ?room= parametr – streamy se nezobrazí.');
} else {
  var ws;
  var myId;
  var peers     = new Map();
  var peerOrder = [];
  var slots     = [1, 2];

  function getSlot(peerId) {
    var idx = peerOrder.indexOf(peerId);
    return idx === -1 ? null : slots[idx];
  }

  function assignStream(peerId, stream) {
    if (!peerOrder.includes(peerId)) {
      if (peerOrder.length < slots.length) peerOrder.push(peerId);
      else return;
    }
    var slot = getSlot(peerId);
    if (!slot) return;
    var vid = document.getElementById('cam-video-' + slot);
    var ph  = document.getElementById('placeholder-' + slot);
    vid.srcObject = stream;
    vid.classList.add('active');
    if (ph) ph.style.display = 'none';
  }

  function freeSlot(peerId) {
    var slot = getSlot(peerId);
    var idx  = peerOrder.indexOf(peerId);
    if (idx !== -1) peerOrder.splice(idx, 1);
    if (!slot) return;
    var vid = document.getElementById('cam-video-' + slot);
    var ph  = document.getElementById('placeholder-' + slot);
    vid.srcObject = null;
    vid.classList.remove('active');
    if (ph) ph.style.display = '';
  }

  function makePCCallbacks(peerId, pc) {
    pc.onicecandidate = function(e) {
      if (e.candidate) ws.send(JSON.stringify({ type: 'signal', to: peerId, signal: { type: 'candidate', candidate: e.candidate } }));
    };
    pc.ontrack = function(e) {
      if (e.streams[0]) assignStream(peerId, e.streams[0]);
    };
    pc.onconnectionstatechange = function() {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        freeSlot(peerId);
        peers.delete(peerId);
      }
    };
  }

  function createPC(peerId) {
    var pc = new RTCPeerConnection(ICE_CONFIG);
    peers.set(peerId, pc);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    makePCCallbacks(peerId, pc);
    return pc;
  }

  function createAnswerPC(peerId) {
    var pc = new RTCPeerConnection(ICE_CONFIG);
    peers.set(peerId, pc);
    makePCCallbacks(peerId, pc);
    return pc;
  }

  function connectWS() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function() {};

    ws.onmessage = async function(e) {
      var msg = JSON.parse(e.data);

      switch (msg.type) {
        case 'id':
          myId = msg.id;
          ws.send(JSON.stringify({ type: 'join', room: ROOM_ID, name: '__overlay__' }));
          break;

        case 'peers':
          for (var i = 0; i < msg.peers.length; i++) {
            var peer = msg.peers[i];
            if (peer.name === '__overlay__') continue;
            var pc = createPC(peer.id);
            var offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'signal', to: peer.id, signal: { type: 'offer', sdp: offer.sdp } }));
          }
          break;

        case 'peer-joined':
          if (msg.name !== '__overlay__' && !peers.has(msg.id)) {
            var pc2 = createPC(msg.id);
            pc2.createOffer().then(function(offer) {
              pc2.setLocalDescription(offer);
              ws.send(JSON.stringify({ type: 'signal', to: msg.id, signal: { type: 'offer', sdp: offer.sdp } }));
            }).catch(function() {});
          }
          break;

        case 'peer-left':
          freeSlot(msg.id);
          if (peers.get(msg.id)) peers.get(msg.id).close();
          peers.delete(msg.id);
          break;

        case 'overlay-sync':
          // Přijat filtr z jiného tabu (vieweru) – aplikuj lokálně
          applyRemoteFilter(msg.cam, msg.settings);
          break;

        case 'signal': {
          var from   = msg.from;
          var signal = msg.signal;

          if (signal.type === 'offer') {
            if (peers.has(from)) { peers.get(from).close(); peers.delete(from); }
            var answerPC = createAnswerPC(from);
            await answerPC.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
            var answer = await answerPC.createAnswer();
            await answerPC.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'signal', to: from, signal: { type: 'answer', sdp: answer.sdp } }));
          } else if (signal.type === 'answer') {
            var p = peers.get(from);
            if (p) await p.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          } else if (signal.type === 'candidate') {
            var pc3 = peers.get(from);
            if (pc3) try { await pc3.addIceCandidate(signal.candidate); } catch(err) {}
          }
          break;
        }
      }
    };

    ws.onclose = function() { setTimeout(connectWS, 2000); };
    ws.onerror = function(e) { console.error('WS overlay error', e); };
  }

  connectWS();
}
