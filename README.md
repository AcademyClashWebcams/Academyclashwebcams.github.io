# WebRTC Studio + Academy Clash Overlay

Živé video přes prohlížeč s nízkou latencí, bez instalace.

## Funkce

- **WebRTC místnosti** – vytvoř roomku, sdílej link, vysílej kameru/mikrofon/obrazovku
- **Academy Clash overlay** – esport broadcast overlay s 2 kamerami (1920×1080)
- **OBS integrace** – `?obs=1` link pro čistý výstup bez UI
- **Sync filtrů** – úprava jasu/kontrastu/saturace/odstínu z vieweru se přenáší do OBS v reálném čase
- **Expirace roomek** – nastavitelná doba platnosti (max 20 dní)

## Spuštění

```bash
npm install
node server.js
```

Server běží na `http://localhost:3000`

## Struktura

```
├── server.js              # Express + WebSocket signaling server
├── public/
│   ├── index.html         # Landing page – vytvoření/připojení do roomky
│   ├── room.html          # Room UI – video grid, ovládání
│   ├── room.js            # WebRTC engine, peer management
│   ├── style.css          # Styling room + landing
│   ├── overlay.html       # Academy Clash overlay (HTML)
│   ├── overlay.css        # Overlay styly
│   ├── overlay-viewer.js  # Overlay logika (WebRTC viewer, filtry, sync)
│   └── navico.png         # Logo
└── package.json
```

## Nasazení

Vyžaduje Node.js server (Express + WebSocket). Doporučené platformy:
- Render
- Railway
- Fly.io
- VPS (Hetzner, DigitalOcean)
