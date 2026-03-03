/* ====================================================
   WebRTC Studio – room.js
   ==================================================== */

// ─── PARAMS ─────────────────────────────────────────
const params     = new URLSearchParams(window.location.search);
const ROOM_ID    = params.get('room') || 'default';
const MY_NAME    = params.get('name') || localStorage.getItem('webrtc-name') || 'Anon';
const OBS_MODE   = params.get('obs') === '1';
const ROOM_EXPIRY = params.get('expiry') ? parseInt(params.get('expiry')) : null;

// ─── KONFIGURACE ICE ────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// ─── ROZLIŠENÍ ──────────────────────────────────────
const RES_MAP = {
  '360p':  { width: 640,  height: 360  },
  '480p':  { width: 854,  height: 480  },
  '720p':  { width: 1280, height: 720  },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4k':    { width: 3840, height: 2160 }
};

// ─── STAV ────────────────────────────────────────────
let ws;
let myId       = null;
let localStream = null;   // kamera / mikrofon
let screenStream = null;  // sdílená obrazovka
let isScreenSharing = false;

let audioMuted = false;
let videoOff   = false;

// peerId -> { pc: RTCPeerConnection, name: string }
const peers = new Map();
// peerId -> nabídky čekající na localStream
const pendingOffers = new Map();

// ─── INIT ────────────────────────────────────────────
async function init() {
  if (OBS_MODE) {
    document.body.classList.add('obs-mode');
  }

  document.getElementById('displayRoomId').textContent = ROOM_ID;
  document.getElementById('roomLinkInput').value  = getRoomLink();
  document.getElementById('obsLinkInput').value   = getObsLink();

  // Získej média
  try {
    localStream = await getMedia();
    addLocalTile(localStream);
    populateDevices();
  } catch (err) {
    showToast('⚠️ Kamera/mikrofon nedostupné: ' + err.message);
    localStream = new MediaStream(); // prázdný stream
    addLocalTile(localStream);
  }

  connectWS();
}

// ─── MEDIA ───────────────────────────────────────────
function getConstraints() {
  const res = document.getElementById('resolutionSelect')?.value || '720p';
  const fps = parseInt(document.getElementById('fpsSelect')?.value || '30');
  const cam = document.getElementById('cameraSelect')?.value;
  const mic = document.getElementById('micSelect')?.value;

  const { width, height } = RES_MAP[res];
  return {
    video: {
      width:     { ideal: width },
      height:    { ideal: height },
      frameRate: { ideal: fps },
      ...(cam ? { deviceId: { exact: cam } } : {})
    },
    audio: mic ? { deviceId: { exact: mic } } : true
  };
}

async function getMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia(getConstraints());
  } catch {
    // fallback bez konkrétního rozlišení
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
}

async function populateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camSel = document.getElementById('cameraSelect');
    const micSel = document.getElementById('micSelect');

    camSel.innerHTML = '';
    micSel.innerHTML = '';

    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`;
      if (d.kind === 'videoinput') camSel.appendChild(opt);
      if (d.kind === 'audioinput') micSel.appendChild(opt);
    });

    // Nastav aktuálně používané zařízení
    if (localStream) {
      const vt = localStream.getVideoTracks()[0];
      const at = localStream.getAudioTracks()[0];
      if (vt) camSel.value = vt.getSettings().deviceId;
      if (at) micSel.value = at.getSettings().deviceId;
    }
  } catch { /* ignoruj */ }
}

// ─── APLIKOVAT VIDEO NASTAVENÍ ───────────────────────
async function applyVideoSettings() {
  if (isScreenSharing) return;
  if (!localStream) return;

  try {
    const res = document.getElementById('resolutionSelect').value;
    const fps = parseInt(document.getElementById('fpsSelect').value);
    const { width, height } = RES_MAP[res];
    const vt = localStream.getVideoTracks()[0];

    if (vt) {
      await vt.applyConstraints({
        width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps }
      });
      await applyBitrate(false);  // znovu aplikuj bitrate po změně tracku
      showToast(`✅ ${res} @ ${fps}fps nastaveno`);
    }
  } catch (err) {
    showToast('⚠️ Rozlišení nepodporováno: ' + err.message);
  }
}

// ─── BITRATE ─────────────────────────────────────────
async function applyBitrate(notify = true) {
  const kbps = parseInt(document.getElementById('bitrateSelect')?.value || '0');
  const bps  = kbps > 0 ? kbps * 1000 : null;

  const promises = [];
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings.forEach(enc => {
      if (bps !== null) enc.maxBitrate = bps;
      else delete enc.maxBitrate;
    });
    promises.push(sender.setParameters(params).catch(() => {}));
  });

  await Promise.all(promises);
  if (notify) {
    showToast(bps ? `✅ Bitrate nastaven na ${kbps} kbps` : '✅ Bitrate: Auto (neomezeno)');
  }
}

async function changeCamera() {
  if (isScreenSharing) return;
  const newStream = await getMedia();
  await replaceVideoTrack(newStream.getVideoTracks()[0]);
  localStream.getAudioTracks()[0]?.stop();
  newStream.getAudioTracks().forEach(t => localStream.addTrack(t));
  showToast('✅ Kamera přepnuta');
}

async function changeMic() {
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: document.getElementById('micSelect').value } }
  });
  const newAt = newStream.getAudioTracks()[0];
  localStream.getAudioTracks().forEach(t => { localStream.removeTrack(t); t.stop(); });
  localStream.addTrack(newAt);
  await replaceAudioTrack(newAt);
  showToast('✅ Mikrofon přepnut');
}

// ─── NAHRADIT TRACK VE VŠECH PC ──────────────────────
async function replaceVideoTrack(newTrack) {
  // v lokálním streamu
  localStream.getVideoTracks().forEach(t => { localStream.removeTrack(t); t.stop(); });
  if (newTrack) localStream.addTrack(newTrack);

  // v každém peer connection
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender && newTrack) sender.replaceTrack(newTrack);
  });

  // aktualizuj lokální video element
  const vid = document.querySelector('#tile-local video');
  if (vid) vid.srcObject = localStream;
}

async function replaceAudioTrack(newTrack) {
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (sender && newTrack) sender.replaceTrack(newTrack);
  });
}

// ─── TLAČÍTKA OVLÁDÁNÍ ───────────────────────────────
function toggleMic() {
  audioMuted = !audioMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !audioMuted);
  const btn = document.getElementById('btnMic');
  btn.textContent = audioMuted ? '🔇' : '🎤';
  btn.classList.toggle('danger', audioMuted);
  btn.classList.toggle('active', audioMuted);
  document.getElementById('micLabel').textContent = audioMuted ? 'Ztlumit' : 'Mikrofon';
  updateLocalDot();
}

function toggleCam() {
  videoOff = !videoOff;
  localStream?.getVideoTracks().forEach(t => t.enabled = !videoOff);
  const btn = document.getElementById('btnCam');
  btn.textContent = videoOff ? '🚫' : '📷';
  btn.classList.toggle('danger', videoOff);
  btn.classList.toggle('active', videoOff);
  document.getElementById('camLabel').textContent = videoOff ? 'Kamera vyp.' : 'Kamera';
  const noVid = document.querySelector('#tile-local .tile-no-video');
  if (noVid) noVid.style.display = videoOff ? 'flex' : 'none';
}

async function toggleScreen() {
  if (isScreenSharing) {
    stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    isScreenSharing = true;

    await replaceVideoTrack(screenTrack);

    const tile = document.getElementById('tile-local');
    if (tile) tile.classList.add('screen-share');

    document.getElementById('btnScreen').classList.add('active');

    screenTrack.onended = () => stopScreenShare();
    showToast('🖥️ Sdílení obrazovky spuštěno');
  } catch (err) {
    showToast('⚠️ Sdílení obrazovky selhalo: ' + err.message);
  }
}

async function stopScreenShare() {
  isScreenSharing = false;
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;

  try {
    const newStream = await getMedia();
    await replaceVideoTrack(newStream.getVideoTracks()[0]);
  } catch { /* kamera nedostupná */ }

  const tile = document.getElementById('tile-local');
  if (tile) tile.classList.remove('screen-share');
  document.getElementById('btnScreen').classList.remove('active');
  showToast('📷 Kamera obnovena');
}

function toggleSettings() {
  document.getElementById('settingsPanel').classList.toggle('open');
  document.getElementById('btnSettings').classList.toggle('active');
}

function leaveRoom() {
  ws?.close();
  peers.forEach(({ pc }) => pc.close());
  peers.clear();
  localStream?.getTracks().forEach(t => t.stop());
  window.location.href = 'index.html';
}

// ─── WEBSOCKET ───────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {};

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'id':
        myId = msg.id;
        ws.send(JSON.stringify({ type: 'join', room: ROOM_ID, name: MY_NAME, expiry: ROOM_EXPIRY }));
        break;

      case 'peers':
        // Existující peeři – my pošleme offer
        for (const peer of msg.peers) {
          await initiatePeer(peer.id, peer.name);
        }
        break;

      case 'peer-joined':
        // Nový peer se připojil – on pošle offer, my čekáme
        setPeerName(msg.id, msg.name);
        break;

      case 'peer-left':
        removePeer(msg.id);
        break;

      case 'name-change':
        setPeerName(msg.id, msg.name);
        break;

      case 'room-info':
        startExpiryCountdown(msg.expiresAt);
        break;

      case 'room-expired':
        alert('⏰ Platnost místnosti vypršela.');
        window.location.href = 'index.html';
        return;

      case 'signal':
        await handleSignal(msg.from, msg.signal);
        break;
    }
  };

  ws.onclose = () => {
    if (!OBS_MODE) showToast('⚠️ Spojení přerušeno. Obnovuji...');
    setTimeout(connectWS, 2000);
  };

  ws.onerror = (e) => console.error('WS error', e);
}

function sendSignal(to, signal) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', to, signal }));
  }
}

// ─── WEBRTC PEER CONNECTION ───────────────────────────
function createPC(peerId, peerName) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  peers.set(peerId, { pc, name: peerName || peerId });

  // Přidej lokální tracky
  localStream?.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(peerId, { type: 'candidate', candidate });
  };

  pc.ontrack = ({ streams }) => {
    if (streams[0]) setRemoteStream(peerId, streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      removePeer(peerId);
    }
    if (pc.connectionState === 'connected') {
      applyBitrate(false); // aplikuj nastavený bitrate hned po připojení
    }
  };

  return pc;
}

async function initiatePeer(peerId, peerName) {
  if (peers.has(peerId)) return;
  const pc = createPC(peerId, peerName);

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  sendSignal(peerId, { type: 'offer', sdp: offer.sdp });
}

async function handleSignal(fromId, signal) {
  if (signal.type === 'offer') {
    if (peers.has(fromId)) peers.get(fromId).pc.close();

    const name = peerNames.get(fromId) || fromId;
    const pc = createPC(fromId, name);

    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(fromId, { type: 'answer', sdp: answer.sdp });

  } else if (signal.type === 'answer') {
    const peer = peers.get(fromId);
    if (peer) await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });

  } else if (signal.type === 'candidate') {
    const peer = peers.get(fromId);
    if (peer) {
      try {
        await peer.pc.addIceCandidate(signal.candidate);
      } catch { /* ignore */ }
    }
  }
}

// ─── DOČASNÁ MAPA JMEN ──────────────────────────────
const peerNames = new Map();
function setPeerName(id, name) {
  peerNames.set(id, name);
  const label = document.querySelector(`#tile-${id} .tile-name`);
  if (label) label.textContent = name;
}

// ─── VIDEO TILES ─────────────────────────────────────
function addLocalTile(stream) {
  const tile = createTile('local', MY_NAME, true);
  const vid = tile.querySelector('video');
  vid.srcObject = stream;
  document.getElementById('videoGrid').prepend(tile);
  updatePeerCount();
}

function setRemoteStream(peerId, stream) {
  let tile = document.getElementById(`tile-${peerId}`);
  if (!tile) {
    const name = peerNames.get(peerId) || peers.get(peerId)?.name || peerId;
    tile = createTile(peerId, name, false);
    document.getElementById('videoGrid').appendChild(tile);
    updatePeerCount();
  }
  const vid = tile.querySelector('video');
  vid.srcObject = stream;
}

function createTile(id, name, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'video-tile' + (isLocal ? ' local' : '');
  tile.id = `tile-${id}`;

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.playsInline = true;
  if (isLocal) vid.muted = true;
  tile.appendChild(vid);

  // Popisek
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.innerHTML = `<span class="dot${audioMuted && isLocal ? ' muted' : ''}"></span>
                     <span class="tile-name">${escHtml(name)}</span>${isLocal ? ' <span style="opacity:.6">(Ty)</span>' : ''}`;
  tile.appendChild(label);

  // Avatar (zobrazí se bez videa)
  const noVid = document.createElement('div');
  noVid.className = 'tile-no-video';
  noVid.style.display = 'none';
  noVid.innerHTML = `<div class="tile-avatar">${getInitial(name)}</div><span>${escHtml(name)}</span>`;
  tile.appendChild(noVid);

  return tile;
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (peer) { peer.pc.close(); peers.delete(peerId); }
  document.getElementById(`tile-${peerId}`)?.remove();
  peerNames.delete(peerId);
  updatePeerCount();
}

function updateLocalDot() {
  const dot = document.querySelector('#tile-local .dot');
  if (dot) dot.classList.toggle('muted', audioMuted);
}

function updatePeerCount() {
  const count = document.querySelectorAll('.video-tile').length;
  document.getElementById('peerCountEl').textContent = count;
  // Uprav grid layout
  const grid = document.getElementById('videoGrid');
  if (count === 1) grid.style.gridTemplateColumns = '1fr';
  else if (count === 2) grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
  else if (count <= 4) grid.style.gridTemplateColumns = 'repeat(2, 1fr)';
  else grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
}

// ─── SDÍLENÍ ODKAZŮ ──────────────────────────────────
function getRoomLink() {
  return `${location.origin}/room.html?room=${ROOM_ID}`;
}
function getObsLink() {
  return `${location.origin}/overlay.html?room=${ROOM_ID}&obs=1`;
}

function copyRoomLink() {
  navigator.clipboard.writeText(getRoomLink())
    .then(() => showToast('✅ Odkaz zkopírován!'))
    .catch(() => showToast('⚠️ Kopírování selhalo'));
}
function copyObsLink() {
  navigator.clipboard.writeText(getObsLink())
    .then(() => showToast('✅ OBS odkaz zkopírován!'))
    .catch(() => showToast('⚠️ Kopírování selhalo'));
}

// ─── TOAST ───────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  if (OBS_MODE) return;
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── UTILS ───────────────────────────────────────────
function getInitial(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── EXPIRY COUNTDOWN ────────────────────────────────
let expiryInterval = null;
function startExpiryCountdown(expiresAt) {
  const wrap = document.getElementById('roomExpiry');
  const el   = document.getElementById('expiryCountdown');
  if (!wrap || !el) return;
  wrap.style.display = '';

  function tick() {
    const diff = expiresAt - Date.now();
    if (diff <= 0) {
      el.textContent = 'Vypršelo';
      wrap.style.color = '#ff4444';
      clearInterval(expiryInterval);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);

    let text = '';
    if (d > 0) text += d + 'd ';
    if (h > 0 || d > 0) text += h + 'h ';
    text += m + 'm ' + s + 's';
    el.textContent = text.trim();

    // Change color when < 1 hour remaining
    if (diff < 3600000) {
      wrap.style.color = '#ff8844';
    } else {
      wrap.style.color = '';
    }
  }

  tick();
  if (expiryInterval) clearInterval(expiryInterval);
  expiryInterval = setInterval(tick, 1000);
}

// ─── START ───────────────────────────────────────────
init();
