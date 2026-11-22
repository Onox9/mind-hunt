/* =========================================================================
   MIND HUNT — client temps réel
   ========================================================================= */
'use strict';

const $ = (id) => document.getElementById(id);
const S = {
  socket: null, code: null, youId: null, name: '', isHost: false,
  room: null, role: null, alive: true, settings: null,
  startedAt: 0, endsAt: 0, nextPingAt: 0, clockOffset: 0,
  targets: [], pingAt: 0, captureRadius: 30,
  pos: null, acc: null, gpsWatch: null, gpsGranted: false, gpsAsked: false,
  map: null, tileLayer: null, meMarker: null, meCircle: null, watchCircle: null,
  markers: new Map(), // playerId -> marker (teammates + pinged targets)
  drawTimer: null
};

/* ------------------------------------------------------------ utilitaires */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; t.style.transition = '.3s'; }, 4200);
  setTimeout(() => t.remove(), 4700);
}
function fmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
  document.body.classList.toggle('in-game', id === 's-game');
  if (id === 's-game' && S.map) setTimeout(() => S.map.invalidateSize(), 80);
  window.scrollTo(0, 0);
}
const cid = () => {
  let c = localStorage.getItem('mh_cid');
  if (!c) { c = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('mh_cid', c); }
  return c;
};
const initials = (n) => (n || '?').slice(0, 2).toUpperCase();
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const haversine = (a, b) => {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
function mapsUrl(lat, lng, label) {
  const dest = Number(lat).toFixed(6) + ',' + Number(lng).toFixed(6);
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'geo:' + dest + '?q=' + dest + '(' + encodeURIComponent(label || 'Cible') + ')';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'https://maps.apple.com/?daddr=' + dest + '&dirflg=w';
  return 'https://www.google.com/maps/dir/?api=1&destination=' + dest + '&travelmode=walking';
}
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }
function beep(freq = 880, dur = 0.14, type = 'sine') {
  try {
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    S.ac = S.ac || new C();
    const o = S.ac.createOscillator(), g = S.ac.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = 0.05; o.connect(g); g.connect(S.ac.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, S.ac.currentTime + dur);
    o.stop(S.ac.currentTime + dur + 0.02);
  } catch (e) {}
}

/* --------------------------------------------------------------- connexion */
function connect() {
  if (S.socket) return S.socket;
  S.socket = io({ transports: ['websocket', 'polling'] });
  const sk = S.socket;

  sk.on('connect_error', () => toast('Connexion au serveur impossible. Réessaie.', 'err'));

  sk.on('joined', ({ code, youId }) => {
    S.code = code; S.youId = youId;
    S.resuming = false;
    localStorage.setItem('mh_name', S.name);
    localStorage.setItem('mh_code', code);
    askGeolocation(true);
    show('s-lobby');
  });

  sk.on('room', (room) => {
    const wasEnded = S.room && S.room.status === 'ended';
    S.room = room; S.isHost = room.hostId === S.youId;
    renderLobby();
    // l'hôte a relancé une manche : tout le monde revient au lobby
    if (room.status === 'lobby' && (wasEnded || (S.role && !S.room.status))) {
      S.role = null; S.alive = true; S.targets = []; S.team = []; S.pingAt = 0; S.endsAt = 0;
      $('sheet').style.display = 'none';
      $('capture-bar').style.display = 'none';
      show('s-lobby');
    }
  });

  sk.on('toast', ({ msg, kind }) => toast(msg, kind || ''));

  sk.on('errmsg', ({ msg }) => {
    if (S.resuming) { S.resuming = false; localStorage.removeItem('mh_code'); return; }
    toast(msg, 'err');
    if (!S.code) $('join-err').textContent = '⚠ ' + msg;
  });

  sk.on('started', (d) => {
    S.role = d.role; S.alive = d.alive !== false; S.settings = d.settings;
    S.startedAt = d.startedAt; S.endsAt = d.endsAt;
    S.clockOffset = Date.now() - (S.room ? S.room.serverNow : Date.now());
    S.nextPingAt = d.startedAt + (d.settings ? d.settings.ping : 180) * 1000;
    S.captureRadius = d.captureRadius || 30;
    S.targets = [];
    if (d.resumed) { enterGame(); toast('🔄 Partie reprise.', 'ok'); }
    else renderDrawThenGame(d);
  });

  sk.on('ping', (d) => {
    S.pingAt = Date.now();
    if (d.targets) {
      S.targets = d.targets.filter((t) => Number.isFinite(t.lat));
      renderTargetsSheet(true);
      flashPing();
      beep(1567, 0.16, 'square'); setTimeout(() => beep(1567, 0.16, 'square'), 220); setTimeout(() => beep(2093, 0.26, 'square'), 440);
      vibrate([90, 60, 90, 60, 160]);
      if (S.role === 'hunter') toast('📡 <b>PING GPS</b> — ' + S.targets.length + ' caché(s) localisé(s). Ouvre la fiche des cibles.', 'warn');
    } else if (d.exposed) {
      flashPing();
      beep(320, 0.3, 'sawtooth'); vibrate([200, 80, 200]);
      toast('🚨 <b>TA POSITION A ÉTÉ PINGÉE.</b> Bouge maintenant !', 'err');
    } else if (d.spectator) {
      flashPing(); toast('📡 Ping envoyé aux chasseurs.', 'warn');
    }
    if (d.nextPingAt) S.nextPingAt = d.nextPingAt;
    drawSelfAndMarkers();
  });

  sk.on('targets', (d) => { // reconnexion
    if (d && d.targets) { S.pingAt = Date.now(); S.targets = d.targets.filter((t) => Number.isFinite(t.lat)); renderTargetsSheet(false); drawSelfAndMarkers(); }
  });

  sk.on('positions', ({ team }) => { S.team = (team || []).filter((t) => Number.isFinite(t.lat)); drawSelfAndMarkers(); });

  sk.on('captured', (d) => {
    beep(220, 0.3, 'sawtooth');
    toast('🎯 <b>' + esc(d.byName) + '</b> a capturé <b>' + esc(d.targetName) + '</b> — ' + d.remaining + ' caché(s) restant(s).', 'ok');
    if (d.targetId) { const m = S.markers.get(d.targetId); if (m) { S.map.removeLayer(m); S.markers.delete(d.targetId); } }
    S.targets = S.targets.filter((t) => t.id !== d.targetId);
    renderTargetsSheet(false);
    if (S.role === 'hidden' && d.targetId === S.youId) { S.alive = false; onMeCaptured(); }
  });

  sk.on('gameover', (d) => renderEnd(d));
  sk.on('kicked', () => { toast('Tu as été retiré du salon par l’hôte.', 'err'); resetToHome(); });
  sk.on('left', () => resetToHome());

  sk.on('disconnect', () => {
    if (S.code) toast('Connexion perdue… tentative de reconnexion.', 'warn');
  });
  sk.on('reconnect', () => {
    if (S.code && S.name) sk.emit('join', { code: S.code, name: S.name, cid: cid() });
  });
  return sk;
}

/* ------------------------------------------------------------- GPS / perm */
function askGeolocation(immediate) {
  if (!navigator.geolocation) {
    setGpsBadge(false, 'GPS non supporté');
    toast('Ton navigateur ne supporte pas la géolocalisation.', 'err');
    return;
  }
  // permission déjà accordée ? on démarre directement
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((st) => {
      if (st.state === 'granted') startGpsWatch();
      else if (st.state === 'prompt' && immediate) $('modal-gps').classList.add('on');
      else if (st.state === 'denied') setGpsBadge(false, 'GPS refusé');
    }).catch(() => $('modal-gps').classList.add('on'));
  } else {
    $('modal-gps').classList.add('on');
  }
}
function startGpsWatch() {
  if (S.gpsWatch) return;
  if (!navigator.geolocation) return;
  S.gpsAsk = true;
  setGpsBadge(null, 'Recherche GPS…');
  S.gpsWatch = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      S.pos = { lat: latitude, lng: longitude }; S.acc = accuracy;
      S.gpsGranted = true;
      setGpsBadge(true, 'GPS actif ±' + Math.round(accuracy) + ' m');
      if (S.socket) S.socket.emit('gpsStatus', { ok: true });
      if (S.socket) S.socket.emit('pos', { lat: latitude, lng: longitude, acc: accuracy });
      $('pill-perm').style.display = 'none';
      ensureMap();
      drawSelfAndMarkers();
      if (S.viewCentered !== true && S.map) { S.viewCentered = true; S.map.setView([latitude, longitude], 16); }
    },
    (e) => {
      setGpsBadge(false, e.code === 1 ? 'GPS refusé' : 'GPS indisponible');
      if (e.code === 1) {
        $('modal-gps').classList.remove('on');
        toast('Localisation refusée. Tu peux l’activer dans les réglages du navigateur puis toucher 📍.', 'err');
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}
function setGpsBadge(ok, label) {
  const b = $('lobby-gps');
  if (!b) return;
  b.textContent = (ok === true ? '📍 ' : ok === false ? '⚠ ' : '⏳ ') + label;
  b.classList.toggle('bad', ok === false);
  const p = $('pill-perm');
  if (p) p.style.display = ok ? 'none' : 'inline-flex';
  if (p && typeof label === 'string') p.textContent = '📍 ' + label;
}

/* --------------------------------------------------------------- la carte */
function ensureMap() {
  if (S.map || typeof L === 'undefined') return;
  const start = S.pos ? [S.pos.lat, S.pos.lng] : [48.8566, 2.3522];
  S.map = L.map('map', {
    zoomControl: false, attributionControl: true,
    center: start, zoom: 16, preferCanvas: true, tap: true
  });
  S.tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(S.map);
  L.control.zoom({ position: 'bottomright' }).addTo(S.map);
  S.meIcon = L.divIcon({
    className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: '<div class="me-pulse" style="width:22px;height:22px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45)"></div>'
  });
  S.map.on('dragstart', () => { S.viewCentered = false; });
}
function avatarIcon(name, kind) {
  const conf = {
    me: { c: '#1a73e8', t: '#fff' },
    hunter: { c: '#ff2d78', t: '#fff' },
    hidden: { c: '#a6ff00', t: '#0a1a00' },
    target: { c: '#ff3b3b', t: '#fff' },
    found: { c: '#a6ff00', t: '#0a1a00' }
  }[kind] || { c: '#00f0ff', t: '#03121a' };
  return L.divIcon({
    className: '', iconSize: [30, 34], iconAnchor: [15, 17],
    html: `<div style="display:flex;flex-direction:column;align-items:center">
      <div style="width:26px;height:26px;border-radius:50%;background:${conf.c};color:${conf.t};border:2px solid #fff;
        display:grid;place-items:center;font:900 10px ui-sans-serif,system-ui;box-shadow:0 2px 8px rgba(0,0,0,.4)">${esc(initials(name))}</div>
      <div style="font:800 8.5px ui-sans-serif,system-ui;color:#fff;background:rgba(6,12,20,.8);padding:1px 4px;border-radius:5px;margin-top:2px">${esc(name)}</div>
    </div>`
  });
}
function drawSelfAndMarkers() {
  if (!S.map) { if (S.pos) ensureMap(); else return; }
  // moi
  if (S.pos) {
    const ll = [S.pos.lat, S.pos.lng];
    if (!S.meMarker) {
      S.meMarker = L.marker(ll, { icon: S.meIcon, zIndexOffset: 1000, interactive: false }).addTo(S.map);
      S.meCircle = L.circle(ll, { radius: S.acc || 20, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12 }).addTo(S.map);
    } else {
      S.meMarker.setLatLng(ll);
      S.meCircle.setLatLng(ll); S.meCircle.setRadius(S.acc || 20);
    }
    if (S.viewCentered !== false && document.body.classList.contains('in-game')) S.map.panTo(ll, { animate: true, duration: 0.4 });
  }
  // coéquipiers connus (chasseurs entre eux / cachés entre eux)
  (S.team || []).forEach((t) => {
    const kind = S.role === 'hunter' ? 'hunter' : 'hidden';
    let m = S.markers.get(t.id);
    if (!m) {
      m = L.marker([t.lat, t.lng], { icon: avatarIcon(t.name, kind) }).addTo(S.map);
      S.markers.set(t.id, m);
    } else m.setLatLng([t.lat, t.lng]);
  });
  // cibles révélées par le ping
  if (S.role === 'hunter') {
    S.targets.forEach((t) => {
      let m = S.markers.get(t.id);
      const icon = avatarIcon(t.name, 'target');
      if (!m) { m = L.marker([t.lat, t.lng], { icon }).addTo(S.map); S.markers.set(t.id, m); }
      else { m.setLatLng([t.lat, t.lng]); m.setIcon(icon); }
    });
  }
}
function flashPing() {
  const f = $('ping-flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}

/* -------------------------------------------------------------- le lobby */
function renderLobby() {
  const r = S.room; if (!r) return;
  $('lobby-code').textContent = r.code;
  $('pcount').textContent = r.players.filter((p) => p.connected).length;
  const s = r.settings;

  $('st-ping').textContent = s.ping < 60 ? s.ping + ' sec' : (s.ping / 60) + ' min';
  $('st-dur').textContent = (s.dur / 60) + ' min';
  $('st-roles').textContent = r.summary.hunters + '⚔ ' + r.summary.hidden + '◉';

  // contrôles : seul l'hôte édite
  const host = S.isHost;
  document.querySelectorAll('#role-card .chip').forEach((c) => c.classList.toggle('on', c.dataset.v === s.roleMode));
  document.querySelectorAll('#chips-ping .chip').forEach((c) => c.classList.toggle('on', +c.dataset.v === s.ping));
  document.querySelectorAll('#chips-dur .chip').forEach((c) => c.classList.toggle('on', +c.dataset.v === s.dur));
  document.querySelectorAll('.val-hunterCount').forEach((e) => (e.textContent = s.hunterCount));
  document.querySelectorAll('.val-totalParticipants').forEach((e) => (e.textContent = s.totalParticipants));
  $('panel-hunters').classList.toggle('hidden', s.roleMode !== 'hunters');
  $('panel-total').classList.toggle('hidden', s.roleMode !== 'total');
  $('role-summary').textContent = s.roleMode === 'hunters'
    ? `⚔ ${r.summary.hunters} chasseur(s) + ${r.summary.hidden} caché(s) = ${r.summary.total} inscrits — tirage aléatoire`
    : `👥 ${r.summary.total} participants au tirage (${r.summary.hunters} ⚔ + ${r.summary.hidden} ◉) — aléatoire parmi les inscrits`;
  $('host-only-hint').style.display = host ? 'none' : 'block';
  document.querySelectorAll('#role-card .chip, #role-card .stepper button, #timing-card .chip')
    .forEach((el) => { el.style.pointerEvents = host ? 'auto' : 'none'; el.style.opacity = host ? '1' : '.55'; });

  const noGps = r.players.filter((p) => p.connected && !p.gpsOk).length;
  $('start-hint').textContent = host
    ? (noGps ? `⚠ ${noGps} joueur(s) sans GPS — la localisation est indispensable pour être localisé.` : '✅ Tous les joueurs partagent leur position. Le tirage sera secret.')
    : 'En attente du lancement par l’hôte…';
  $('start-hint').style.color = host && noGps ? 'var(--amber)' : '';
  $('btn-start').style.display = host ? 'flex' : 'none';

  $('players').innerHTML = r.players.map((p) => `
    <div class="player">
      <div class="av" style="color:${p.color};border-color:${p.color};background:${p.color}1a">${esc(initials(p.name))}</div>
      <div class="nm"><b>${esc(p.name)}${p.id === S.youId ? ' (toi)' : ''}</b>
        <span>${p.isHost ? 'HÔTE · ' : ''}${p.gpsOk ? 'GPS actif' : 'GPS en attente'} · ${p.connected ? 'en ligne' : 'déconnecté'}</span></div>
      <span class="dot ${p.gpsOk ? 'ok' : p.connected ? '' : 'off'}"></span>
      ${host && p.id !== S.youId && r.status === 'lobby' ? `<button class="kick" data-kick="${p.id}">✕</button>` : ''}
    </div>`).join('');
  $('players').querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => S.socket.emit('kick', { playerId: b.dataset.kick });
  });
}

/* --------------------------------------------------------------- tirage */
function renderDrawThenGame(d) {
  show('s-draw');
  const card = $('draw-card');
  card.style.borderColor = 'var(--cyan)';
  card.style.boxShadow = '0 0 40px rgba(0,240,255,.3)';
  $('draw-dots').innerHTML = '<i></i><i></i><i></i><i></i><i></i>';
  $('draw-text').textContent = 'Le système mélange les rôles…';
  const seq = ['?', '⚔', '◉', '?', '⌖', '?', '⚔', '◉', '?'];
  let step = 0;
  clearInterval(S.drawTimer);
  S.drawTimer = setInterval(() => {
    card.textContent = seq[step % seq.length];
    [...$('draw-dots').children].forEach((dot, i) => {
      dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${i <= step % 5 ? 'var(--cyan)' : 'var(--panel2)'};box-shadow:${i <= step % 5 ? '0 0 8px rgba(0,240,255,.7)' : 'none'}`;
    });
    beep(500 + step * 60, 0.05, 'square');
    step++;
    if (step === seq.length) {
      clearInterval(S.drawTimer);
      finishDrawCard(d);
    }
  }, 220);
}
function finishDrawCard(d) {
  const isHunter = S.role === 'hunter', isSpec = S.role === 'spectator';
  const card = $('draw-card');
  card.textContent = isHunter ? '⚔' : isSpec ? '👁' : '◉';
  card.style.borderColor = isHunter ? 'var(--pink)' : isSpec ? 'var(--muted)' : 'var(--lime)';
  card.style.boxShadow = isHunter ? '0 0 50px rgba(255,45,120,.5)' : '0 0 50px rgba(166,255,0,.45)';
  const sum = d.summary || (S.room && S.room.summary) || { hunters: 0, hidden: 0, total: 0 };
  const head = `<div style="font-size:10px;color:var(--muted);letter-spacing:1px;margin-bottom:8px">TIRAGE : ${sum.hunters} ⚔ CHASSEURS · ${sum.hidden} ◉ CACHÉS · ${sum.total} PARTICIPANTS</div>`;
  $('draw-text').innerHTML = head + (isHunter
    ? '<b style="color:var(--pink);font-size:17px">TU ES CHASSEUR ⚔</b><br><span style="font-size:12.5px">Traque les cachés grâce aux pings GPS. Capture à moins de ' + (S.captureRadius || 30) + ' m.</span>'
    : isSpec
      ? '<b style="color:var(--muted);font-size:17px">TU ES SPECTATEUR 👁</b><br><span style="font-size:12.5px">Effectif limité par l’hôte. Tu suis la carte sans compter dans le tirage.</span>'
      : '<b style="color:var(--lime);font-size:17px">TU ES CACHÉ ◉</b><br><span style="font-size:12.5px">À chaque ping ta position est révélée. Bouge constamment pour survivre !</span>');
  beep(isHunter ? 220 : 880, 0.3, 'sawtooth');
  setTimeout(() => beep(isHunter ? 330 : 1174, 0.36, 'sawtooth'), 170);
  setTimeout(enterGame, 2300);
}

/* ---------------------------------------------------------------- le jeu */
function enterGame() {
  show('s-game');
  const isHunter = S.role === 'hunter', isSpec = S.role === 'spectator';
  const badge = $('role-badge');
  badge.className = 'role-badge ' + (isHunter ? 'role-hunter' : isSpec ? 'role-spec' : 'role-hidden');
  badge.textContent = isHunter ? '⚔ CHASSEUR' : isSpec ? '👁 SPECTATEUR' : '◉ CACHÉ';
  $('hud-code').textContent = S.code || '';
  $('pill-role').style.display = 'none';
  $('pill-perm').style.display = S.gpsGranted ? 'none' : 'inline-flex';
  ensureMap();
  if (S.pos && S.map) S.map.setView([S.pos.lat, S.pos.lng], 16);
  askGeolocation(true);
  if (S.role === 'hunter') toast('🎯 Mission : ouvre la fiche des cibles après chaque ping et lance l’itinéraire 🧭 Maps.', 'ok');
  else if (S.role === 'hidden') toast('🕶 Reste invisible et bouge après chaque ping. Évite les chasseurs à moins de 60 m.', 'warn');
  drawSelfAndMarkers();
  tick();
}
let tickTimer = null;
function tick() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!S.endsAt) return;
    const now = Date.now();
    const endLeft = (S.endsAt - now) / 1000;
    const pingLeft = (S.nextPingAt - now) / 1000;
    $('hud-end').textContent = '⏱ ' + fmt(endLeft);
    $('hud-ping').textContent = '📡 ' + fmt(pingLeft);
    $('hud-ping').classList.toggle('warn', pingLeft < 15 && pingLeft > 0);
    if (endLeft <= 0) clearInterval(tickTimer);
    updateCaptureBtn();
  }, 500);
}
function updateCaptureBtn() {
  if (S.role !== 'hunter' || !S.pos || !S.targets.length) {
    $('capture-bar').style.display = 'none'; return;
  }
  let best = null, bd = Infinity;
  S.targets.forEach((t) => { const d = haversine(S.pos, t); if (d < bd) { bd = d; best = t; } });
  const bar = $('capture-bar');
  if (best && bd <= S.captureRadius * 2.2) {
    bar.style.display = 'block';
    $('btn-capture').textContent = `🎯 CAPTURER ${best.name} — ${Math.round(bd)} m`;
    $('btn-capture').onclick = () => S.socket.emit('capture', { targetId: best.id });
  } else bar.style.display = 'none';
}

/* ------------------------------------------------------------- fiche cibles */
function setSheet(open) {
  const sheet = $('sheet'), toggle = $('btn-sheet-toggle');
  sheet.style.display = open ? 'block' : 'none';
  sheet.classList.toggle('open', false);
  if (toggle) {
    toggle.style.display = (S.role === 'hunter' && S.targets.length) || (S.role === 'hidden' && S.pingAt && Date.now() - S.pingAt < 20000) ? 'inline-flex' : 'none';
  }
  updateCaptureBtn();
}
function renderTargetsSheet(autoOpen) {
  const sheet = $('sheet');
  if (S.role !== 'hunter') {
    // côté caché : rappel de sa propre position
    if (S.pingAt && Date.now() - S.pingAt < 20000) {
      sheet.style.display = 'block';
      $('btn-sheet-toggle').style.display = 'inline-flex';
      $('sheet-title').textContent = '🚨 TA POSITION A ÉTÉ PINGÉE';
      $('sheet-body').innerHTML = S.pos ? `
        <div class="target-row"><div class="av">!</div>
          <div class="inf"><b>Révélée aux chasseurs</b><span>${S.pos.lat.toFixed(5)}, ${S.pos.lng.toFixed(5)} · ±${Math.round(S.acc || 20)} m</span></div>
          <a class="navbtn" href="${mapsUrl(S.pos.lat, S.pos.lng, 'Ma position')}" target="_blank" rel="noopener">🧭 Maps</a></div>
        <p class="hint">Déplace-toi d’au moins 100 m avant le prochain ping.</p>`
        : '<p class="hint">GPS indisponible : active la localisation (bouton 📍).</p>';
    } else { sheet.style.display = 'none'; $('btn-sheet-toggle').style.display = 'none'; }
    return;
  }
  sheet.style.display = 'block';
  $('btn-sheet-toggle').style.display = 'inline-flex';
  const n = S.targets.length;
  $('sheet-title').textContent = n ? `🎯 CIBLES DU PING — ${n} caché(s)` : '🎯 AUCUNE CIBLE';
  if (!n) {
    $('sheet-body').innerHTML = '<p class="hint">Aucun caché localisé à ce ping (GPS coupé ?). Continue à patrouiller.</p>';
    return;
  }
  $('sheet-body').innerHTML = S.targets.map((t) => {
    const d = S.pos ? Math.round(haversine(S.pos, t)) : null;
    return `<div class="target-row">
      <div class="av">${esc(initials(t.name))}</div>
      <div class="inf"><b>${esc(t.name)}${d !== null ? ' · ' + d + ' m' : ''}</b>
        <span>${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}${t.acc ? ' · ±' + Math.round(t.acc) + ' m' : ''}</span></div>
      <a class="navbtn" href="${mapsUrl(t.lat, t.lng, t.name)}" target="_blank" rel="noopener" data-nav="${t.id}">🧭 Maps</a>
    </div>`;
  }).join('') + (n > 1 ? `<button class="btn btn-lime mt" id="btn-nearest">🧭 Ouvrir la cible la plus proche dans Maps</button>` : '');
  const near = $('btn-nearest');
  if (near) near.onclick = () => {
    if (!S.pos) return toast('GPS requis pour calculer la cible la plus proche.', 'err');
    let best = null, bd = Infinity;
    S.targets.forEach((t) => { const d = haversine(S.pos, t); if (d < bd) { bd = d; best = t; } });
    if (best) window.open(mapsUrl(best.lat, best.lng, best.name), '_blank');
  };
  $('sheet-body').querySelectorAll('[data-nav]').forEach((a) => {
    a.addEventListener('click', () => toast('🧭 Ouverture de l’application de cartographie…', 'ok'));
  });
  if (autoOpen) sheet.style.display = 'block';
}

function onMeCaptured() {
  $('role-badge').className = 'role-badge role-spec';
  $('role-badge').textContent = '💀 CAPTURÉ';
  $('capture-bar').style.display = 'none';
  if (S.meMarker && S.map) { S.map.removeLayer(S.meMarker); S.meMarker = null; }
  toast('💀 Tu as été capturé. Tu observes la fin de la partie.', 'err');
}

/* ------------------------------------------------------------- fin de partie */
function renderEnd(d) {
  clearInterval(tickTimer);
  show('s-end');
  $('end-code').textContent = 'SALON ' + (S.code || '');
  const iWin = S.role === 'spectator' ? false : (d.huntersWin ? S.role === 'hunter' : S.role === 'hidden');
  $('end-ico').textContent = d.huntersWin ? '⚔' : '◉';
  $('end-title').textContent = d.huntersWin ? 'VICTOIRE DES CHASSEURS' : 'VICTOIRE DES CACHÉS';
  $('end-title').style.color = d.huntersWin ? 'var(--pink)' : 'var(--lime)';
  const why = d.huntersWin
    ? 'Tous les cachés ont été capturés.'
    : (d.survivors && d.survivors.length ? `${d.survivors.length} caché(s) ont survécu jusqu'au bout : ${d.survivors.map(esc).join(', ')}.` : 'Chrono écoulé, les cachés l’emportent.');
  $('end-why').innerHTML = why + '<br><b style="color:' + (iWin ? 'var(--lime)' : 'var(--muted)') + '">' + (S.role === 'spectator' ? 'Tu étais spectateur.' : iWin ? 'Tu fais partie des vainqueurs 🎉' : 'Rôle perdant cette manche — la revanche t’attend.') + '</b>';
  const order = { hunter: 0, hidden: 1, spectator: 2 };
  const list = [...d.players].sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3) || b.captures - a.captures);
  $('end-players').innerHTML = list.map((p) => {
    const roleTxt = p.role === 'hunter' ? '⚔ CHASSEUR' : p.role === 'hidden' ? '◉ CACHÉ' : '👁 SPECTATEUR';
    const state = p.role === 'spectator' ? 'HORS TIRAGE' : p.role === 'hunter' ? (p.captures ? p.captures + ' capture(s)' : 'EN JEU') : (p.alive ? 'SURVIVANT' : 'CAPTURÉ');
    return `<div class="player"><div class="av" style="width:32px;height:32px;font-size:11px">${esc(initials(p.name))}</div>
      <div class="nm"><b>${esc(p.name)}${p.id === S.youId ? ' (toi)' : ''}</b><span>${roleTxt} · ${state}</span></div>
      <span class="tag">${state.split(' ')[0]}</span></div>`;
  }).join('');
  $('end-code').textContent = 'SALON ' + (S.code || '');
  $('btn-replay').style.display = S.isHost ? 'flex' : 'none';
  if (!S.isHost) toast('En attente de l’hôte pour relancer une manche.', 'warn');
}
function leaveVoluntary(emit = true) {
  localStorage.removeItem('mh_code');
  if (emit && S.socket && S.code) S.socket.emit('leave');
  resetToHome();
}
function resetToHome() {
  clearInterval(tickTimer); clearInterval(S.drawTimer);
  localStorage.removeItem('mh_code');
  if (S.gpsWatch) { navigator.geolocation.clearWatch(S.gpsWatch); S.gpsWatch = null; }
  if (S.map) { S.map.remove(); S.map = null; S.meMarker = null; S.meCircle = null; S.markers = new Map(); }
  S.code = null; S.youId = null; S.room = null; S.role = null; S.targets = []; S.team = [];
  S.viewCentered = false;
  if (S.socket) S.socket.disconnect();
  S.socket = null;
  show('s-home');
}

/* --------------------------------------------------------------- actions UI */
function onChips(container, onPick) {
  const el = $(container); if (!el) return;
  el.querySelectorAll('.chip').forEach((c) => { c.onclick = () => { onPick(c.dataset.v); beep(720, 0.05, 'square'); }; });
}
function pushSettings(patch) {
  const s = { ...(S.room ? S.room.settings : {}), ...patch };
  S.socket.emit('setSettings', s);
}
function wire() {
  $('btn-create').onclick = () => {
    const n = $('inp-pseudo').value.trim();
    if (!n) return toast('Choisis d’abord un pseudo.', 'err');
    S.name = n; connect().emit('create', { name: n, cid: cid() });
  };
  $('btn-join').onclick = doJoin;
  $('inp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('inp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });

  $('btn-copy').onclick = async () => {
    const url = location.origin + '/?join=' + S.code;
    const txt = `Rejoins ma partie Mind Hunt 🎯\nCode : ${S.code}\n${url}`;
    try { await navigator.clipboard.writeText(txt); toast('Lien et code copiés — colle-les dans ton groupe.', 'ok'); }
    catch (e) { prompt('Copie ce lien :', txt); }
  };
  $('btn-leave-lobby').onclick = () => leaveVoluntary();
  $('btn-start').onclick = () => {
    const noGps = (S.room ? S.room.players : []).filter((p) => p.connected && !p.gpsOk);
    if (noGps.length) {
      const names = noGps.map((p) => p.name).join(', ');
      if (!confirm('Sans GPS, ces joueurs ne pourront pas être localisés ni capturés :\n\n' + names + '\n\nLancer quand même ?')) return;
    }
    if (!S.gpsGranted) askGeolocation(true);
    S.socket.emit('start');
  };
  $('btn-quit').onclick = () => {
    if (confirm('Quitter la partie ? Tu sortiras du salon.')) leaveVoluntary();
  };
  $('btn-home').onclick = resetToHome;
  $('btn-replay').onclick = () => S.socket.emit('replay');
  $('sheet-close').onclick = () => setSheet(false);
  $('btn-sheet-toggle').onclick = () => setSheet($('sheet').style.display !== 'block');
  $('fab-center').onclick = () => {
    if (S.pos && S.map) { S.viewCentered = true; S.map.setView([S.pos.lat, S.pos.lng], 16, { animate: true }); }
    else { askGeolocation(false); toast('Active le GPS pour te recentrer.', 'warn'); }
  };
  $('btn-gps-allow').onclick = () => { $('modal-gps').classList.remove('on'); startGpsWatch(); };
  $('btn-gps-later').onclick = () => { $('modal-gps').classList.remove('on'); toast('Tu peux relancer la demande avec le bouton 📍 ou le ⌖ de la carte.', 'warn'); };
  $('btn-gps-again').onclick = () => { if (S.gpsGranted && S.pos) { S.viewCentered = true; S.map && S.map.setView([S.pos.lat, S.pos.lng], 16); toast('Position partagée : ' + S.pos.lat.toFixed(5) + ', ' + S.pos.lng.toFixed(5), 'ok'); } else askGeolocation(true); };

  onChips('chips-rolemode', (v) => pushSettings({ roleMode: v }));
  onChips('chips-ping', (v) => pushSettings({ ping: +v }));
  onChips('chips-dur', (v) => pushSettings({ dur: +v }));
  document.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => {
      if (!S.isHost) return;
      const [key, delta] = b.dataset.step.split(':');
      const cur = S.room ? S.room.settings[key] : 0;
      pushSettings({ [key]: cur + (+delta) });
      beep(700, 0.05, 'square');
    };
  });

  // reprise de session (reload, retour d'arrière-plan, écran verrouillé)
  const savedCode = localStorage.getItem('mh_code');
  const savedName = localStorage.getItem('mh_name');
  if (savedCode && savedName && !new URLSearchParams(location.search).get('join')) {
    S.name = savedName; S.resuming = true;
    $('inp-pseudo').value = savedName;
    connect().emit('join', { code: savedCode, name: savedName, cid: cid() });
    setTimeout(() => { if (!S.code) { S.resuming = false; localStorage.removeItem('mh_code'); } }, 4000);
  }

  // invitation par lien ?join=CODE
  const q = new URLSearchParams(location.search);
  const joinCode = (q.get('join') || '').toUpperCase().slice(0, 5);
  if (joinCode) {
    $('inp-code').value = joinCode;
    $('join-code-lbl').textContent = joinCode;
    $('inp-join-name').value = localStorage.getItem('mh_name') || '';
    $('modal-join').classList.add('on');
  }
  $('btn-join-cancel').onclick = () => { $('modal-join').classList.remove('on'); history.replaceState({}, '', '/'); };
  $('btn-join-go').onclick = () => {
    const n = $('inp-join-name').value.trim();
    if (!n) return toast('Choisis un pseudo.', 'err');
    S.name = n;
    $('modal-join').classList.remove('on');
    connect().emit('join', { code: joinCode, name: n, cid: cid() });
    history.replaceState({}, '', '/');
  };
}
function doJoin() {
  const n = $('inp-pseudo').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  $('join-err').textContent = '';
  if (!n) return toast('Choisis d’abord un pseudo.', 'err');
  if (code.length < 4 || code.length > 5) { $('join-err').textContent = '⚠ Le code fait 4 ou 5 caractères.'; return; }
  S.name = n;
  connect().emit('join', { code, name: n, cid: cid() });
}

/* --------------------------------------------------------------- démarrage */
wire();
window.addEventListener('beforeunload', () => {
  // on n'émet PAS 'leave' : un reload / verrouillage d'écran doit permettre de reprendre la partie.
  if (S.socket && S.code) S.socket.emit('pagehide');
});
