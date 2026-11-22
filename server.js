/* =========================================================================
   MIND HUNT — serveur temps réel (Node.js + Socket.io + Express)
   - Salons à code 4–5 caractères
   - Tirage des rôles configuré par l'hôte (chasseurs fixes OU effectif total)
   - Chrono de ping autoritaire côté serveur
   - Positions réelles GPS, révélées aux chasseurs UNIQUEMENT au ping
   - Captures vérifiées côté serveur (distance réelle)
   ========================================================================= */
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CAPTURE_R = 30;          // m — rayon de capture (GPS urbain)
const MAX_PLAYERS = 30;
const ROOM_TTL = 3 * 3600e3;   // purge des salons vides après 3 h
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I/O/0/1
const COLORS = ['#00f0ff','#a6ff00','#ff2d78','#ffb020','#b06bff','#2dffb3','#ff6b6b','#6bc5ff'];

/* ---------------------------------------------------------------- utils */
const rooms = new Map(); // code -> room

const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
function genCode() {
  let c;
  do {
    c = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(c));
  return c;
}
function cleanName(n) {
  return String(n || '').replace(/[<>&"'`\\]/g, '').trim().slice(0, 18) || 'Joueur';
}
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const alive = (p) => p.alive !== false;

function defaultSettings() {
  return { ping: 180, dur: 600, roleMode: 'hunters', hunterCount: 2, totalParticipants: 8 };
}
function sanitizeSettings(inp, prev) {
  const s = { ...defaultSettings(), ...(prev || {}) };
  if (!inp || typeof inp !== 'object') return s;
  if ([15, 60, 180, 300].includes(+inp.ping)) s.ping = +inp.ping;
  if ([300, 600, 1200, 1800].includes(+inp.dur)) s.dur = +inp.dur;
  if (inp.roleMode === 'hunters' || inp.roleMode === 'total') s.roleMode = inp.roleMode;
  if (Number.isFinite(+inp.hunterCount)) s.hunterCount = clamp(Math.round(+inp.hunterCount), 1, 20);
  if (Number.isFinite(+inp.totalParticipants)) s.totalParticipants = clamp(Math.round(+inp.totalParticipants), 2, MAX_PLAYERS);
  return s;
}

function newRoom(code, hostPlayer) {
  return {
    code,
    hostId: hostPlayer.id,
    createdAt: now(),
    settings: defaultSettings(),
    status: 'lobby', // lobby | playing | ended
    players: new Map([[hostPlayer.id, hostPlayer]]),
    startedAt: 0, endsAt: 0, nextPingAt: 0,
    lastPing: null, // {at, targets:[{id,name,lat,lng}]}
    pingCount: 0,
    pingTimer: null, endTimer: null,
    lastActivity: now()
  };
}

/* ------------------------------------------------------- vues publiques */
function settingsSummary(room) {
  const n = room.players.size;
  const s = room.settings;
  if (s.roleMode === 'hunters') {
    const h = clamp(s.hunterCount, 1, Math.max(1, n - 1));
    return { hunters: h, hidden: Math.max(0, n - h), total: n };
  }
  const eff = Math.min(s.totalParticipants, n);
  const h = clamp(s.hunterCount, 1, Math.max(1, eff - 1));
  return { hunters: h, hidden: Math.max(0, eff - h), total: eff };
}

/** Vue d'un salon pour un joueur donné : les rôles restent secrets. */
function viewRoom(room, viewerId) {
  const viewer = room.players.get(viewerId);
  const vRole = viewer ? viewer.role : null;
  const showAllRoles = room.status === 'ended';
  const players = [...room.players.values()].map((p) => {
    let role = '?';
    if (p.id === viewerId || showAllRoles) role = p.role;
    else if (room.status !== 'lobby' && vRole === 'hunter' && p.role === 'hunter') role = 'hunter';
    return {
      id: p.id, name: p.name, color: p.color,
      connected: p.connected !== false,
      isHost: p.id === room.hostId,
      gpsOk: !!p.gpsOk,
      role,
      alive: p.alive !== false,
      captures: p.captures || 0,
      lat: p.id === viewerId || p.role === 'hunter' && vRole === 'hunter' ? p.lat : null,
      lng: p.id === viewerId || p.role === 'hunter' && vRole === 'hunter' ? p.lng : null
    };
  });
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    summary: settingsSummary(room),
    hostId: room.hostId,
    players,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    nextPingAt: room.nextPingAt,
    serverNow: now(),
    captureRadius: CAPTURE_R
  };
}

/* ------------------------------------------------------------- émission */
let io; // défini au boot
function emitRoom(room, event = 'room') {
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit(event, viewRoom(room, p.id));
  }
}
function emitToPlayer(room, playerId, event, payload) {
  const p = room.players.get(playerId);
  if (p && p.socketId) io.to(p.socketId).emit(event, payload);
}
function toastRoom(room, msg, kind = 'info') {
  for (const p of room.players.values()) if (p.socketId) io.to(p.socketId).emit('toast', { msg, kind });
}

/* ------------------------------------------------------- boucle de jeu */
function clearTimers(room) {
  if (room.pingTimer) clearTimeout(room.pingTimer);
  if (room.endTimer) clearTimeout(room.endTimer);
  room.pingTimer = room.endTimer = null;
}

function schedulePing(room) {
  clearTimeout(room.pingTimer);
  room.nextPingAt = now() + room.settings.ping * 1000;
  room.pingTimer = setTimeout(() => doPing(room), room.settings.ping * 1000);
}

function scheduleEnd(room) {
  clearTimeout(room.endTimer);
  const ms = Math.max(0, room.endsAt - now());
  room.endTimer = setTimeout(() => finishGame(room, 'time'), ms);
}

function doPing(room) {
  if (room.status !== 'playing') return;
  room.pingCount++;
  const targets = [...room.players.values()]
    .filter((p) => p.role === 'hidden' && alive(p) && Number.isFinite(p.lat))
    .map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, acc: p.acc || 20, at: p.ts || now() }));
  room.lastPing = { at: now(), targets };
  room.lastActivity = now();

  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    if (p.role === 'hunter') {
      io.to(p.socketId).emit('ping', {
        at: room.lastPing.at,
        count: targets.length,
        targets,
        nextPingAt: now() + room.settings.ping * 1000
      });
    } else if (p.role === 'hidden' && alive(p)) {
      io.to(p.socketId).emit('ping', {
        at: room.lastPing.at, exposed: true,
        self: Number.isFinite(p.lat) ? { lat: p.lat, lng: p.lng } : null,
        nextPingAt: now() + room.settings.ping * 1000
      });
    } else if (p.socketId) {
      io.to(p.socketId).emit('ping', { at: room.lastPing.at, spectator: true, nextPingAt: now() + room.settings.ping * 1000 });
    }
  }
  emitRoom(room);
  schedulePing(room);
}

function finishGame(room, reason) {
  if (room.status !== 'playing') return;
  clearTimers(room);
  room.status = 'ended';
  room.lastActivity = now();
  const hiddenAlive = [...room.players.values()].filter((p) => p.role === 'hidden' && alive(p));
  const huntersWin = reason === 'allCaptured' || hiddenAlive.length === 0;
  const results = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, role: p.role, alive: alive(p),
    captures: p.captures || 0, connected: p.connected !== false
  }));
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('gameover', {
      huntersWin, reason,
      survivors: hiddenAlive.map((h) => h.name),
      players: results,
      settings: room.settings
    });
  }
  emitRoom(room);
}

/* --------------------------------------------------------- démarrage */
function startGame(room) {
  const n = room.players.size;
  if (n < 2) return { error: 'Il faut au moins 2 joueurs dans le salon.' };
  const s = room.settings;
  let pool = [...room.players.values()];
  if (s.roleMode === 'total') {
    const eff = clamp(s.totalParticipants, 2, n);
    const host = room.players.get(room.hostId);
    const others = pool.filter((p) => p.id !== room.hostId).sort(() => Math.random() - 0.5);
    pool = host ? [host, ...others.slice(0, eff - 1)] : others.slice(0, eff);
  }
  const nHunters = clamp(s.hunterCount, 1, Math.max(1, pool.length - 1));

  // tirage aléatoire (Fisher-Yates)
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (const p of room.players.values()) {
    p.role = 'spectator'; p.alive = false; p.captures = 0;
  }
  shuffled.forEach((p, i) => {
    p.role = i < nHunters ? 'hunter' : 'hidden';
    p.alive = true; p.captures = 0;
    if (!Number.isFinite(p.lat)) { p.lat = null; p.lng = null; }
  });

  room.status = 'playing';
  room.startedAt = now();
  room.endsAt = room.startedAt + s.dur * 1000;
  room.lastPing = null;
  room.pingCount = 0;
  room.lastActivity = now();

  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('started', {
      role: p.role,
      alive: p.role !== 'spectator',
      settings: s,
      startedAt: room.startedAt, endsAt: room.endsAt,
      summary: settingsSummary(room),
      captureRadius: CAPTURE_R
    });
  }
  emitRoom(room);
  schedulePing(room);
  scheduleEnd(room);
  return { ok: true };
}

/* ------------------------------------------------------------ serveur */
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, file) => {
    if (/\.(js|css|html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));

// téléchargement du paquet complet (fichiers + guide)
app.get('/telecharger', (_req, res) => {
  res.download(path.join(__dirname, 'public', 'mind-hunt.zip'), 'mind-hunt-a-telecharger.zip');
});

const server = http.createServer(app);
io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 20000, pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

/* -------------------------------------------------------------- sockets */
io.on('connection', (socket) => {
  const ctx = { code: null, playerId: null };

  const err = (msg) => socket.emit('errmsg', { msg });
  const getRoom = () => (ctx.code ? rooms.get(ctx.code) : null);
  const getMe = () => { const r = getRoom(); return r ? r.players.get(ctx.playerId) : null; };
  const isHost = () => { const r = getRoom(); return r && r.hostId === ctx.playerId; };

  function bind(room, player) {
    ctx.code = room.code; ctx.playerId = player.id;
    player.socketId = socket.id;
    player.connected = true;
    socket.emit('joined', { code: room.code, youId: player.id });
    emitRoom(room);
  }

  socket.on('create', ({ name, cid } = {}) => {
    const code = genCode();
    const player = {
      id: 'p' + Math.random().toString(36).slice(2, 9),
      cid: String(cid || '').slice(0, 40) || null,
      name: cleanName(name),
      color: COLORS[0],
      role: null, alive: true, captures: 0,
      lat: null, lng: null, acc: null, ts: 0,
      gpsOk: false, connected: true, socketId: socket.id, joinedAt: now()
    };
    const room = newRoom(code, player);
    rooms.set(code, room);
    bind(room, player);
    console.log(`[room ${code}] créé par ${player.name}`);
  });

  socket.on('join', ({ code, name, cid } = {}) => {
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return err('Salon introuvable. Vérifie le code.');
    if (room.status !== 'lobby') {
      // reconnexion d'un joueur existant ?
      const existing = [...room.players.values()].find(
        (p) => cid && p.cid === cid && (room.status === 'playing' || room.status === 'ended')
      );

      if (existing) {
        existing.socketId = socket.id; existing.connected = true;
        bind(room, existing);
        if (room.status === 'playing') {
          socket.emit('started', {
            role: existing.role, alive: existing.alive, settings: room.settings,
            startedAt: room.startedAt, endsAt: room.endsAt,
            summary: settingsSummary(room), captureRadius: CAPTURE_R, resumed: true
          });
          if (room.lastPing) socket.emit('targets', room.lastPing);
        }
        return;
      }
      return err('Partie déjà lancée dans ce salon.');
    }
    // même appareil qui revient (reload) : on réutilise sa fiche
    if (cid) {
      const mine = [...room.players.values()].find((p) => p.cid === String(cid));
      if (mine) {
        mine.name = cleanName(name) || mine.name;
        bind(room, mine);
        return;
      }
    }
    if (room.players.size >= MAX_PLAYERS) return err('Salon complet (30 joueurs max).');
    const player = {
      id: 'p' + Math.random().toString(36).slice(2, 9),
      cid: String(cid || '').slice(0, 40) || null,
      name: cleanName(name),
      color: COLORS[room.players.size % COLORS.length],
      role: null, alive: true, captures: 0,
      lat: null, lng: null, acc: null, ts: 0,
      gpsOk: false, connected: true, socketId: socket.id, joinedAt: now()
    };
    room.players.set(player.id, player);
    room.lastActivity = now();
    bind(room, player);
    toastRoom(room, `${player.name} a rejoint le salon.`, 'ok');
    console.log(`[room ${code}] ${player.name} rejoint (${room.players.size})`);
  });

  socket.on('setSettings', (inp) => {
    const room = getRoom();
    if (!room || !isHost() || room.status !== 'lobby') return;
    room.settings = sanitizeSettings(inp, room.settings);
    emitRoom(room);
  });

  socket.on('kick', ({ playerId } = {}) => {
    const room = getRoom();
    if (!room || !isHost() || room.status !== 'lobby' || playerId === room.hostId) return;
    const p = room.players.get(playerId);
    if (!p) return;
    room.players.delete(playerId);
    if (p.socketId) io.to(p.socketId).emit('kicked');
    emitRoom(room);
  });

  socket.on('gpsStatus', ({ ok } = {}) => {
    const room = getRoom(); const me = getMe();
    if (!room || !me) return;
    me.gpsOk = !!ok;
    emitRoom(room);
  });

  socket.on('start', () => {
    const room = getRoom();
    if (!room || !isHost() || room.status !== 'lobby') return;
    const r = startGame(room);
    if (r.error) err(r.error);
  });

  socket.on('pos', ({ lat, lng, acc } = {}) => {
    const me = getMe(); const room = getRoom();
    if (!me || !room) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    me.lat = lat; me.lng = lng; me.acc = Number.isFinite(acc) ? acc : null;
    me.ts = now();
    me.gpsOk = true;
    if (room.status === 'playing') broadcastPositions(room);
  });

  function broadcastPositions(room) {
    const list = [...room.players.values()].filter((p) => alive(p) && p.role !== 'spectator' && Number.isFinite(p.lat));
    const hunters = list.filter((p) => p.role === 'hunter').map(p => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng }));
    const hiddens = list.filter((p) => p.role === 'hidden').map(p => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng }));
    for (const p of room.players.values()) {
      if (!p.socketId) continue;
      if (p.role === 'hunter') io.to(p.socketId).emit('positions', { team: hunters });
      else if (p.role === 'hidden') io.to(p.socketId).emit('positions', { team: hiddens.filter(h => h.id !== p.id) });
    }
  }

  socket.on('capture', ({ targetId } = {}) => {
    const room = getRoom(); const me = getMe();
    if (!room || !me || room.status !== 'playing' || me.role !== 'hunter' || !alive(me)) return;
    const target = room.players.get(targetId);
    if (!target || target.role !== 'hidden' || !alive(target)) return;
    if (!Number.isFinite(me.lat) || !Number.isFinite(target.lat)) return err('Position GPS manquante.');
    const d = haversine(me, target);
    if (d > CAPTURE_R) return err(`Trop loin : ${Math.round(d)} m (max ${CAPTURE_R} m).`);
    target.alive = false;
    me.captures = (me.captures || 0) + 1;
    for (const p of room.players.values()) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit('captured', {
        targetId: target.id, targetName: target.name, byName: me.name,
        captures: me.captures,
        remaining: [...room.players.values()].filter((x) => x.role === 'hidden' && alive(x)).length
      });
    }
    emitRoom(room);
    const remaining = [...room.players.values()].filter((p) => p.role === 'hidden' && alive(p));
    if (remaining.length === 0) finishGame(room, 'allCaptured');
  });

  socket.on('replay', () => {
    const room = getRoom();
    if (!room || !isHost()) return;
    clearTimers(room);
    room.status = 'lobby';
    room.lastPing = null; room.pingCount = 0;
    room.startedAt = room.endsAt = room.nextPingAt = 0;
    for (const p of room.players.values()) {
      p.role = null; p.alive = true; p.captures = 0;
    }
    emitRoom(room);
    toastRoom(room, 'Nouvelle manche : l’hôte peut relancer le tirage.', 'ok');
  });

  socket.on('leave', () => {
    const room = getRoom();
    if (!room) return;
    room.players.delete(ctx.playerId);
    if (room.players.size === 0) {
      clearTimers(room); rooms.delete(room.code);
    } else {
      if (room.hostId === ctx.playerId) {
        room.hostId = [...room.players.values()][0].id;
      }
      emitRoom(room);
    }
    ctx.code = null; ctx.playerId = null;
    socket.emit('left');
  });

  socket.on('pagehide', () => {
    const room = getRoom(); const me = getMe();
    if (!room || !me) return;
    me.connected = false; me.socketId = null;
    if (room.status === 'lobby') {
      room.players.delete(me.id);
      if (room.players.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
      if (room.hostId === me.id) room.hostId = [...room.players.values()][0].id;
    }
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(); const me = getMe();
    if (!room || !me) return;
    me.connected = false;
    me.socketId = null;
    if (room.status === 'lobby') {
      room.players.delete(me.id);
      if (room.players.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
      if (room.hostId === me.id) room.hostId = [...room.players.values()][0].id;
    }
    emitRoom(room);
  });
});

/* purge périodique */
setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) {
    const empty = [...room.players.values()].every((p) => !p.connected);
    if ((room.players.size === 0 || empty) && t - room.lastActivity > ROOM_TTL) {
      clearTimers(room); rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

/* démarrage (HTTP, ou HTTPS si certificats fournis) */
if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
  const https = require('https');
  const opts = {
    key: fs.readFileSync(process.env.HTTPS_KEY),
    cert: fs.readFileSync(process.env.HTTPS_CERT)
  };
  const srv = https.createServer(opts, app);
  io.attach(srv);
  srv.listen(PORT, '0.0.0.0', () => console.log(`🔒 Mind Hunt HTTPS sur le port ${PORT}`));
} else {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Mind Hunt sur http://0.0.0.0:${PORT} (mets un reverse proxy HTTPS devant pour le GPS en production)`);
  });
}
