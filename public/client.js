'use strict';
// LaxBall web client: renders server snapshots and sends your inputs.

(() => {
  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $('game'), ctx = canvas.getContext('2d');
  const joinScreen = $('joinScreen'), roomScreen = $('roomScreen');
  const chatlog = $('chatlog'), chatinput = $('chatinput');
  const banner = $('banner'), bannerBig = $('bannerBig'), bannerSmall = $('bannerSmall');

  const COLORS = { 1: '#e56e56', 2: '#5689e5' };
  const TICK_MS = 1000 / 60;
  const INTERP_MS = 45;

  // ---------- state ----------
  let ws = null;
  let myId = 0, cfg = null, checkTicks = 12;
  let roster = new Map();
  let room = { admin: 0, state: 'lobby', settings: { scoreLimit: 3, timeLimit: 3 }, score: [0, 0] };
  let snaps = [];
  let clockOffset = null;
  let lastHud = '';
  let bannerTimer = null;
  let mouseAim = localStorage.getItem('lax.mouseAim') !== '0'; // on by default
  let soundOn = localStorage.getItem('lax.sound') !== '0';
  let mouse = { x: 0, y: 0, buttons: 0 };
  let lastAimSent = null;
  let view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  let flashes = []; // short-lived text pops on the field

  // Aim: the crosshair sits at an offset from your player (field units) and can't go
  // further than AIM_RADIUS_FRAC x the field length (0.5 = half the field).
  const AIM_RADIUS_FRAC = 0.5;
  let aimOff = { x: 120, y: 0 };
  let pointerLocked = false;
  let menuOpenedByUs = false; // set when we release the pointer lock ourselves
  let lastLockLoss = -1e9;
  let chatOpen = false, unread = 0;

  // Which device is aiming right now: 'mouse', 'pad' (game controller) or 'touch' (phone).
  let aimSource = 'mouse';
  let aimModeSent = null;
  let padBits = 0, touchBits = 0;              // throw/check buttons held on the controller / touch button
  let padMove = { x: 0, y: 0 }, touchMove = { x: 0, y: 0 }, lastMoveSent = '0,0';
  let touchMode = false;
  const PAD_AIM_DIST = 140;                     // how far ahead the crosshair sits when aiming with a stick
  // Stick response: 0 = smoothed (original feel), 100 = the stick snaps straight to your aim.
  let turnPct = 0;
  try { turnPct = Math.max(0, Math.min(100, parseInt(localStorage.getItem('lax.turn') || '0', 10) || 0)); } catch { /* default */ }
  const aimRadius = () => (cfg ? cfg.hw * 2 : 1120) * AIM_RADIUS_FRAC;

  // Crosshair settings (saved per browser)
  const XH_DEFAULT = { shape: 'crossdot', color: '#00ff66', size: 9, thick: 2, gap: 4, alpha: 1, outline: true, sens: 1 };
  const XH_COLORS = ['#00ff66', '#ff2d2d', '#00e5ff', '#ffee00', '#ffffff', '#ff3df5', '#ff8c00', '#9b6bff'];
  let xh = { ...XH_DEFAULT };
  try { xh = { ...XH_DEFAULT, ...JSON.parse(localStorage.getItem('lax.crosshair') || '{}') }; } catch { /* defaults */ }

  // ---------- join ----------
  $('nick').value = localStorage.getItem('lax.name') || '';
  $('avatar').value = localStorage.getItem('lax.avatar') || '';
  $('optMouse').checked = mouseAim;
  $('optSound').checked = soundOn;
  setTimeout(() => $('nick').focus(), 50);

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nick').value.trim() || 'Player';
    const avatar = $('avatar').value.trim();
    localStorage.setItem('lax.name', name);
    localStorage.setItem('lax.avatar', avatar);
    unlockAudio();
    enterFullscreen();
    connect(name, avatar);
  });

  // ---------- fullscreen & pointer lock ----------
  function enterFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      // In Chrome/Edge this lets a short Esc press open our menu; holding Esc still exits fullscreen.
      if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(['Escape']).catch(() => {});
    }).catch(() => {});
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else enterFullscreen();
  }
  function canLockAim() {
    return mouseAim && !touchMode && aimSource === 'mouse' && room.state === 'playing' && roomScreen.classList.contains('hidden') && !chatOpen && myTeam() !== 0;
  }
  function lockAim() {
    if (!canLockAim() || pointerLocked || !canvas.requestPointerLock) return;
    try {
      const r = canvas.requestPointerLock({ unadjustedMovement: true });
      if (r && r.catch) r.catch(() => { try { canvas.requestPointerLock(); } catch { /* needs a click */ } });
    } catch { /* needs a click */ }
  }
  function unlockAim() {
    if (document.pointerLockElement) { menuOpenedByUs = true; document.exitPointerLock(); }
  }
  function myTeam() { const p = roster.get(myId); return p ? p.team : 0; }
  document.addEventListener('pointerlockchange', () => {
    const was = pointerLocked;
    pointerLocked = document.pointerLockElement === canvas;
    if (pointerLocked) mouse.moved = false; // don't snap back to the old real-mouse spot later
    if (was && !pointerLocked) {
      lastLockLoss = performance.now();
      releaseKeys();
      if (menuOpenedByUs) { menuOpenedByUs = false; return; }
      // The browser released the lock (usually Esc): treat it like opening the menu.
      if (chatOpen) closeChat();
      else if (room.state === 'playing') roomScreen.classList.remove('hidden');
    }
  });
  $('fsBtn').addEventListener('click', toggleFullscreen);

  function connect(name, avatar) {
    $('joinStatus').textContent = 'Connecting…';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => send({ t: 'join', name, avatar });
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      joinScreen.classList.remove('hidden');
      roomScreen.classList.add('hidden');
      $('hud').classList.add('hidden');
      $('joinStatus').textContent = myId ? 'Disconnected from the server. Join again?' : 'Could not connect to the server.';
      myId = 0; snaps = []; roster = new Map();
    };
  }
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  // ---------- messages ----------
  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.id; cfg = m.cfg; checkTicks = m.phys.checkTicks;
        joinScreen.classList.add('hidden');
        roomScreen.classList.remove('hidden');
        aimModeSent = null; updateAimMode();
        send({ t: 'turn', v: turnPct / 100 });
        break;
      case 'room': {
        const prevState = room.state;
        room = m;
        roster = new Map(m.players.map((p) => [p.id, p]));
        if (prevState !== 'playing' && m.state === 'playing') { roomScreen.classList.add('hidden'); snaps = []; clockOffset = null; }
        if (prevState === 'playing' && m.state !== 'playing') { unlockAim(); roomScreen.classList.remove('hidden'); snaps = []; }
        if (myTeam() === 0) unlockAim();
        $('hud').classList.toggle('hidden', m.state !== 'playing');
        $('hint').classList.toggle('hidden', m.state !== 'playing');
        renderRoom();
        break;
      }
      case 's': onSnapshot(m); break;
      case 'chat': addChat(m); break;
      case 'kicked': addChat({ sys: true, m: 'You were removed from the room.' }); break;
    }
  }

  function onSnapshot(s) {
    s.time = s.k * TICK_MS;
    const off = s.time - performance.now();
    if (clockOffset === null || Math.abs(off - clockOffset) > 400) clockOffset = off;
    else clockOffset += (off - clockOffset) * 0.06;
    snaps.push(s);
    if (snaps.length > 90) snaps.shift();
    if (s.ev) for (const e of s.ev) onEvent(e, s);
    $('pausedNote').classList.toggle('hidden', !s.pa);
  }

  function nameOf(id) { const p = roster.get(id); return p ? p.name : 'someone'; }

  function onEvent(e, s) {
    switch (e.e) {
      case 'throw': sfx.throw(e.power); break;
      case 'catch': sfx.catch(); break;
      case 'swing': if (e.id === myId) sfx.swing(); break;
      case 'check': sfx.check(); flash('CHECK!', s.b[0], s.b[1], '#ffd54f'); break;
      case 'deflect': sfx.clack(); flash('SAVE', s.b[0], s.b[1], '#fff'); break;
      case 'post': sfx.post(); break;
      case 'out': sfx.whistle(); flash('OUT', s.b[0], s.b[1], '#ff8a80'); break;
      case 'whistle': sfx.whistle(); break;
      case 'goal': {
        sfx.goal();
        let sub = '';
        if (e.scorer) sub = e.own ? `Own goal by ${nameOf(e.scorer)}` : `${nameOf(e.scorer)}` + (e.assist ? `  (assist ${nameOf(e.assist)})` : '');
        showBanner('GOAL!', sub, COLORS[e.team], 2400);
        break;
      }
      case 'overtime': showBanner('OVERTIME', 'Next goal wins', '#ffcc4d', 2000); sfx.whistle(); break;
      case 'over':
        sfx.whistle();
        showBanner(e.winner ? (e.winner === 1 ? 'RED WINS!' : 'BLUE WINS!') : 'DRAW', `${s.sc[0]} - ${s.sc[1]}`, e.winner ? COLORS[e.winner] : '#fff', 4800);
        break;
    }
  }

  function showBanner(big, small, color, ms) {
    bannerBig.textContent = big; bannerBig.style.color = color;
    bannerSmall.textContent = small;
    banner.classList.remove('hidden');
    banner.style.animation = 'none'; void banner.offsetWidth; banner.style.animation = '';
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.add('hidden'), ms);
  }
  function flash(text, x, y, color) { flashes.push({ text, x, y, color, t: performance.now() }); }

  // ---------- chat ----------
  function addChat(m) {
    const div = document.createElement('div');
    if (m.sys) { div.className = 'sys'; div.textContent = m.m; }
    else {
      const n = document.createElement('span');
      n.className = 'n' + (m.team || 0); n.textContent = m.from + ': ';
      div.appendChild(n); div.appendChild(document.createTextNode(m.m));
    }
    chatlog.appendChild(div);
    while (chatlog.children.length > 120) chatlog.firstChild.remove();
    chatlog.scrollTop = chatlog.scrollHeight;
    if (!chatOpen && !m.sys) { unread++; updateChatBadge(); }
  }
  function updateChatBadge() {
    const b = $('chatBadge');
    b.textContent = `${unread} new message${unread === 1 ? '' : 's'} · press / to read`;
    b.classList.toggle('hidden', unread === 0 || chatOpen);
  }
  function openChat() {
    if (!myId) return;
    chatOpen = true;
    unread = 0; updateChatBadge();
    releaseKeys();
    $('chat').classList.remove('hidden');
    chatlog.scrollTop = chatlog.scrollHeight;
    chatinput.focus();
  }
  function closeChat() {
    if (!chatOpen) return;
    chatOpen = false;
    chatinput.value = '';
    $('chat').classList.add('hidden');
    if (document.activeElement === chatinput) chatinput.blur();
  }
  chatinput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = chatinput.value.trim();
      if (v) send({ t: 'chat', m: v });
      closeChat();
      e.preventDefault();
    } else if (e.key === 'Escape') { closeChat(); e.preventDefault(); }
    e.stopPropagation();
  });
  chatinput.addEventListener('blur', () => setTimeout(closeChat, 0));

  // ---------- room / lobby ----------
  const isAdmin = () => room.admin === myId;
  function renderRoom() {
    const admin = isAdmin();
    document.querySelectorAll('.adminOnly').forEach((el) => el.classList.toggle('hidden', !admin));
    $('notAdmin').classList.toggle('hidden', admin || room.state === 'playing');
    const playing = room.state === 'playing';
    $('startBtn').textContent = playing ? 'Stop game' : 'Start game';
    $('startBtn').classList.toggle('danger', playing);
    $('startBtn').classList.toggle('primary', !playing);
    $('pauseBtn').classList.toggle('hidden', !admin || !playing);
    $('closeRoom').classList.toggle('hidden', !playing);
    $('scoreLimit').value = String(room.settings.scoreLimit);
    $('timeLimit').value = String(room.settings.timeLimit);
    $('scoreLimit').disabled = $('timeLimit').disabled = playing;
    $('roomState').textContent = playing ? `Game in progress · ${room.score[0]} - ${room.score[1]}` : 'In the lobby';

    for (const ul of document.querySelectorAll('.plist')) {
      const team = +ul.dataset.team;
      ul.innerHTML = '';
      for (const p of room.players.filter((q) => q.team === team)) {
        const li = document.createElement('li');
        li.dataset.id = p.id;
        if (admin || p.id === myId) {
          li.draggable = true;
          li.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(p.id)));
        }
        const av = document.createElement('span'); av.className = 'av'; av.textContent = p.avatar;
        const nm = document.createElement('span'); nm.className = 'nm' + (p.id === myId ? ' me' : '');
        nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
        li.append(av, nm);
        if (p.id === room.admin) { const a = document.createElement('span'); a.className = 'tagA'; a.textContent = 'ADMIN'; li.append(a); }
        if (admin) {
          const order = [1, 0, 2], i = order.indexOf(team);
          if (i > 0) li.append(mkBtn('mv', '◀', 'Move left', () => send({ t: 'team', id: p.id, team: order[i - 1] })));
          if (i < 2) li.append(mkBtn('mv', '▶', 'Move right', () => send({ t: 'team', id: p.id, team: order[i + 1] })));
          if (p.id !== myId) li.append(mkBtn('x', '✕', p.bot ? 'Remove bot' : 'Kick', () => send({ t: 'kick', id: p.id })));
        }
        ul.appendChild(li);
      }
    }
  }
  function mkBtn(cls, txt, title, fn) {
    const b = document.createElement('button'); b.className = cls; b.textContent = txt; b.title = title;
    b.addEventListener('click', fn); return b;
  }
  document.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('drop');
      const id = +e.dataTransfer.getData('text/plain');
      if (id) send({ t: 'team', id, team: +col.dataset.team });
    });
  });
  document.querySelectorAll('.joinTeam').forEach((b) => b.addEventListener('click', () => send({ t: 'team', id: myId, team: +b.dataset.team })));
  document.querySelectorAll('.addBot').forEach((b) => b.addEventListener('click', () => send({ t: 'addBot', team: +b.dataset.team })));
  $('removeBots').addEventListener('click', () => send({ t: 'removeBots' }));
  $('startBtn').addEventListener('click', () => send({ t: room.state === 'playing' ? 'stop' : 'start' }));
  $('pauseBtn').addEventListener('click', () => send({ t: 'pause' }));
  $('closeRoom').addEventListener('click', () => { roomScreen.classList.add('hidden'); lockAim(); });
  const sendSettings = () => send({ t: 'settings', scoreLimit: +$('scoreLimit').value, timeLimit: +$('timeLimit').value });
  $('scoreLimit').addEventListener('change', sendSettings);
  $('timeLimit').addEventListener('change', sendSettings);
  $('optMouse').addEventListener('change', (e) => {
    mouseAim = e.target.checked;
    localStorage.setItem('lax.mouseAim', mouseAim ? '1' : '0');
    aimModeSent = null; updateAimMode();
    if (!mouseAim) unlockAim();
    canvas.classList.toggle('aiming', mouseAim);
  });
  $('optSound').addEventListener('change', (e) => { soundOn = e.target.checked; localStorage.setItem('lax.sound', soundOn ? '1' : '0'); });
  canvas.classList.toggle('aiming', mouseAim);

  // ---------- input ----------
  const KEYMAP = {
    ArrowUp: 1, KeyW: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 4, KeyA: 4, ArrowRight: 8, KeyD: 8,
    Space: 16, KeyX: 32, ShiftLeft: 32, ShiftRight: 32, KeyK: 32,
  };
  const down = new Set();
  let sentBits = -1;
  function currentBits() {
    let k = 0;
    for (const c of down) k |= KEYMAP[c] || 0;
    if (mouseAim) { if (mouse.buttons & 1) k |= 16; if (mouse.buttons & 2) k |= 32; }
    return k | padBits | touchBits;
  }
  function pushInput() {
    const k = currentBits();
    if (k !== sentBits) { sentBits = k; send({ t: 'input', k }); }
  }
  function releaseKeys() { down.clear(); mouse.buttons = 0; pushInput(); }
  // Only text boxes swallow keys; sliders and checkboxes in the menu don't.
  const typing = () => {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type);
  };

  window.addEventListener('keydown', (e) => {
    unlockAudio();
    if (!myId || typing()) return;
    if (e.key === '/') { e.preventDefault(); openChat(); return; }
    if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) { toggleFullscreen(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Same Esc press that made the browser drop the cursor lock: the menu is already open.
      if (performance.now() - lastLockLoss < 300) return;
      if (room.state === 'playing') {
        if (roomScreen.classList.contains('hidden')) { roomScreen.classList.remove('hidden'); unlockAim(); }
        else { roomScreen.classList.add('hidden'); lockAim(); }
        releaseKeys();
      }
      return;
    }
    if (e.code === 'KeyP' && isAdmin() && room.state === 'playing') { send({ t: 'pause' }); return; }
    if (!roomScreen.classList.contains('hidden')) return;
    if (KEYMAP[e.code]) {
      e.preventDefault();
      down.add(e.code);
      pushInput();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) { down.delete(e.code); pushInput(); }
  });
  window.addEventListener('blur', releaseKeys);

  function clampAim() {
    const R = aimRadius(), l = Math.hypot(aimOff.x, aimOff.y);
    if (l > R) { aimOff.x *= R / l; aimOff.y *= R / l; }
  }
  let lockErrorAt = -1e9;
  document.addEventListener('pointerlockerror', () => { lockErrorAt = performance.now(); });
  document.addEventListener('mousemove', (e) => {
    if (touchMode) return; // phones send fake mouse events after taps
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2 && aimSource !== 'mouse') { aimSource = 'mouse'; updateAimMode(); }
    if (pointerLocked) {
      // Locked: the mouse moves the crosshair relative to your player.
      // Ignore bogus jumps some browsers emit right after locking (a real flick is far smaller per event).
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      const k = xh.sens * view.dpr / view.scale;
      aimOff.x += e.movementX * k; aimOff.y += e.movementY * k;
      clampAim();
    } else {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.moved = true;
    }
  });
  canvas.addEventListener('mousedown', (e) => {
    unlockAudio();
    if (chatOpen) closeChat();
    if (!mouseAim) return;
    if (!pointerLocked && canLockAim() && performance.now() - lockErrorAt > 5000) {
      lockAim(); // this click only grabs the cursor; it doesn't throw
      return;
    }
    mouse.buttons |= e.button === 2 ? 2 : e.button === 0 ? 1 : 0;
    pushInput();
  });
  window.addEventListener('mouseup', (e) => {
    if (!mouseAim) return;
    mouse.buttons &= ~(e.button === 2 ? 2 : e.button === 0 ? 1 : 0);
    pushInput();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- sound ----------
  let actx = null;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { /* no audio */ }
  }
  function tone(freq, dur, type = 'sine', vol = 0.12, slide = null, delay = 0) {
    if (!soundOn || !actx) return;
    const t0 = actx.currentTime + delay;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function noise(dur, vol, freq, q = 1, delay = 0) {
    if (!soundOn || !actx) return;
    const t0 = actx.currentTime + delay;
    const len = Math.floor(actx.sampleRate * dur);
    const buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource(); src.buffer = buf;
    const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = actx.createGain();
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(actx.destination);
    src.start(t0);
  }
  const sfx = {
    throw: (p) => { noise(0.09, 0.25 + p * 0.3, 900 + p * 900, 1.2); tone(260 + p * 160, 0.08, 'triangle', 0.08, 120); },
    catch: () => { tone(700, 0.05, 'triangle', 0.08, 420); noise(0.05, 0.12, 1800, 2); },
    swing: () => noise(0.08, 0.12, 2600, 0.8),
    check: () => { noise(0.07, 0.35, 1400, 3); tone(180, 0.09, 'square', 0.06, 90); },
    clack: () => { noise(0.05, 0.3, 2200, 4); },
    post: () => { tone(1250, 0.35, 'triangle', 0.1, 1180); tone(1870, 0.25, 'sine', 0.05); },
    whistle: () => { for (let i = 0; i < 6; i++) tone(2600 + (i % 2) * 180, 0.06, 'sine', 0.06, null, i * 0.05); },
    goal: () => {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.1, null, i * 0.09));
      noise(1.6, 0.18, 700, 0.5, 0.05);
    },
  };

  // ---------- interpolation ----------
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function stateAt() {
    if (!snaps.length) return null;
    const latest = snaps[snaps.length - 1];
    if (clockOffset === null || latest.pa) return latest;
    const t = performance.now() + clockOffset - INTERP_MS;
    let a = null, b = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].time <= t) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    }
    if (!a) return snaps[0];
    if (!b) return a;
    const f = Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time || 1)));
    const prev = new Map(a.p.map((p) => [p[0], p]));
    const players = b.p.map((pb) => {
      const pa = prev.get(pb[0]);
      if (!pa || Math.hypot(pb[1] - pa[1], pb[2] - pa[2]) > 60) return pb;
      return [pb[0], pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f, lerpAngle(pa[3], pb[3], f), pb[4], pb[5]];
    });
    let ball = b.b;
    if (b.b[2] && players.find((p) => p[0] === b.b[2])) {
      const c = players.find((p) => p[0] === b.b[2]);
      ball = [c[1] + Math.cos(c[3]) * cfg.pocketDist, c[2] + Math.sin(c[3]) * cfg.pocketDist, b.b[2]];
      ball[0] = Math.max(-cfg.hw + cfg.ballR, Math.min(cfg.hw - cfg.ballR, ball[0]));
      ball[1] = Math.max(-cfg.hh + cfg.ballR, Math.min(cfg.hh - cfg.ballR, ball[1]));
    } else if (Math.hypot(b.b[0] - a.b[0], b.b[1] - a.b[1]) < 60) {
      ball = [a.b[0] + (b.b[0] - a.b[0]) * f, a.b[1] + (b.b[1] - a.b[1]) * f, 0];
    }
    return { ...b, p: players, b: ball };
  }

  // ---------- rendering ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  function computeView() {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width, H = canvas.height;
    const fw = (cfg ? cfg.pmx : 600) * 2 + 30, fh = (cfg ? cfg.pmy : 325) * 2 + 30;
    const top = (innerHeight < 500 ? 8 : 52) * dpr;   // phones in landscape: let the field use the full height
    const scale = Math.min(W / fw, (H - top) / fh);
    view = { scale, ox: W / 2, oy: top + (H - top) / 2, dpr };
  }
  const toScreen = (x, y) => ({ x: (view.ox + x * view.scale) / view.dpr, y: (view.oy + y * view.scale) / view.dpr });

  function drawField(st) {
    const c = cfg;
    // grass
    ctx.fillStyle = '#718c5a';
    ctx.fillRect(-c.pmx, -c.pmy, c.pmx * 2, c.pmy * 2);
    ctx.fillStyle = '#6a8453';
    const band = 80;
    for (let x = -c.pmx, i = 0; x < c.pmx; x += band, i++) if (i % 2) ctx.fillRect(x, -c.pmy, Math.min(band, c.pmx - x), c.pmy * 2);

    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(-c.hw, -c.hh, c.hw * 2, c.hh * 2);
    line(0, -c.hh, 0, c.hh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    line(-c.restrainX, -c.hh, -c.restrainX, c.hh);
    line(c.restrainX, -c.hh, c.restrainX, c.hh);
    // wing lines
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    line(-20, -c.hh + 50, 20, -c.hh + 50); line(-20, c.hh - 50, 20, c.hh - 50);

    // centre circle, tinted for the team taking the kickoff
    ctx.beginPath(); ctx.arc(0, 0, c.centerR, 0, Math.PI * 2);
    if (st && st.ph === 0) { ctx.fillStyle = hexA(COLORS[st.ko], 0.18); ctx.fill(); }
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
    ctx.lineWidth = 2;
    line(-7, -7, 7, 7); line(-7, 7, 7, -7);

    for (const side of [-1, 1]) {
      const cx = side * (c.goalX + c.creaseOff);
      ctx.beginPath(); ctx.arc(cx, 0, c.creaseR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5; ctx.stroke();
      // goal line
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      line(side * c.goalX, -c.postY, side * c.goalX, c.postY);
    }
  }
  function drawGoals() {
    const c = cfg;
    for (const side of [-1, 1]) {
      const mx = side * c.goalX, ax = side * (c.goalX + c.goalDepth);
      ctx.save();
      ctx.beginPath(); ctx.moveTo(mx, -c.postY); ctx.lineTo(ax, 0); ctx.lineTo(mx, c.postY); ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 0.8;
      for (let k = -60; k <= 60; k += 7) { line(mx + k, -c.postY, mx + k + 60, c.postY); line(mx + k, c.postY, mx + k + 60, -c.postY); }
      ctx.restore();
      ctx.strokeStyle = '#ff7b1c'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(mx, -c.postY); ctx.lineTo(ax, 0); ctx.lineTo(mx, c.postY); ctx.stroke();
      for (const y of [-c.postY, c.postY]) {
        ctx.beginPath(); ctx.arc(mx, y, c.postR, 0, Math.PI * 2);
        ctx.fillStyle = '#ff7b1c'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
      }
    }
  }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function stickAngle(p) {
    const swing = p[5];
    if (!swing) return p[3];
    const t = 1 - swing / checkTicks;
    return p[3] + (0.5 - t) * 2.2;
  }

  function drawStick(p) {
    const a = stickAngle(p), r = cfg.playerR, pd = cfg.pocketDist + (p[5] ? 6 : 0);
    const ca = Math.cos(a), sa = Math.sin(a);
    if (p[5]) {
      // swing trail
      ctx.beginPath(); ctx.arc(p[1], p[2], pd, p[3] + 1.1, a, true);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 5; ctx.stroke();
    }
    ctx.strokeStyle = '#1d1d1d'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    line(p[1] + ca * (r - 3), p[2] + sa * (r - 3), p[1] + ca * (pd - 7), p[2] + sa * (pd - 7));
    ctx.save();
    ctx.translate(p[1] + ca * pd, p[2] + sa * pd);
    ctx.rotate(a);
    ctx.beginPath(); ctx.ellipse(0, 0, 8.5, 7.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(25,25,25,0.35)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.7;
    line(-6, -4, 6, -4); line(-7, 0, 7, 0); line(-6, 4, 6, 4); line(-3, -6, -3, 6); line(2, -6.5, 2, 6.5);
    ctx.beginPath(); ctx.ellipse(0, 0, 8.5, 7.5, 0, 0, Math.PI * 2);
    ctx.strokeStyle = '#f5f5f5'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  function drawPlayer(p, info) {
    const r = cfg.playerR, x = p[1], y = p[2];
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[info ? info.team : 1] || '#999'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = p[0] === myId ? '#ffffff' : '#000000'; ctx.stroke();
    if (info) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${info.avatar && info.avatar.length > 1 ? 12 : 14}px "Segoe UI", Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(info.avatar || '', x, y + 1);
    }
  }
  function drawCharge(p) {
    const c = p[4] / 100;
    if (c <= 0) return;
    const r = cfg.playerR + 5;
    ctx.beginPath(); ctx.arc(p[1], p[2], r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.arc(p[1], p[2], r, -Math.PI / 2, -Math.PI / 2 + c * Math.PI * 2);
    ctx.strokeStyle = `hsl(${55 - c * 55}, 100%, ${c >= 1 ? 62 : 55}%)`; ctx.lineWidth = 4; ctx.lineCap = 'butt'; ctx.stroke();
  }
  function drawName(p, info) {
    if (!info) return;
    ctx.font = '10px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(info.name, p[1] + 0.8, p[2] + cfg.playerR + 6.8);
    ctx.fillStyle = p[0] === myId ? '#fff' : 'rgba(255,255,255,0.8)';
    ctx.fillText(info.name, p[1], p[2] + cfg.playerR + 6);
  }
  function drawBall(b) {
    ctx.beginPath(); ctx.arc(b[0] + 1.5, b[1] + 2, cfg.ballR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fill();
    ctx.beginPath(); ctx.arc(b[0], b[1], cfg.ballR, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = '#000'; ctx.stroke();
  }
  function drawFlashes(now) {
    flashes = flashes.filter((f) => now - f.t < 800);
    for (const f of flashes) {
      const k = (now - f.t) / 800;
      ctx.globalAlpha = 1 - k;
      ctx.font = 'bold 13px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(f.text, f.x, f.y - 18 - k * 20);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y - 18 - k * 20);
      ctx.globalAlpha = 1;
    }
  }

  function updateHud(st) {
    if (!st) return;
    const m = Math.floor(st.tm / 60), s = st.tm % 60;
    const key = `${st.sc[0]}|${st.sc[1]}|${st.tm}|${st.ot}`;
    if (key === lastHud) return;
    lastHud = key;
    $('scoreR').textContent = st.sc[0];
    $('scoreB').textContent = st.sc[1];
    $('clock').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    $('ot').classList.toggle('hidden', !st.ot);
  }

  // Works out the crosshair offset from your player, sends the aim angle, and returns your player.
  function aimingWithPointer() { return mouseAim || aimSource !== 'mouse'; }
  function updateAimMode() {
    const want = aimingWithPointer();
    if (want === aimModeSent || !myId) return;
    aimModeSent = want; lastAimSent = null;
    send({ t: 'aimMode', on: want, a: Math.atan2(aimOff.y, aimOff.x) });
  }
  function sendAim(st) {
    if (!aimingWithPointer() || !st || !myId) return null;
    const me = st.p.find((p) => p[0] === myId);
    if (!me) return null;
    if (aimSource === 'mouse' && !pointerLocked && mouse.moved) {
      // Not locked (menu open, or lock refused): follow the real mouse, still within the radius.
      const s = toScreen(me[1], me[2]);
      aimOff.x = (mouse.x - s.x) * view.dpr / view.scale;
      aimOff.y = (mouse.y - s.y) * view.dpr / view.scale;
      clampAim();
    }
    if (Math.hypot(aimOff.x, aimOff.y) > 0.5) {
      const a = Math.atan2(aimOff.y, aimOff.x);
      if (lastAimSent === null || Math.abs(a - lastAimSent) > 0.004) { lastAimSent = a; send({ t: 'aim', a }); }
    }
    return me;
  }

  // ---------- crosshair ----------
  function drawCrosshair(c, x, y, o) {
    const s = o.size, t = o.thick, g = o.gap;
    c.save();
    c.globalAlpha = o.alpha;
    c.lineCap = 'butt'; c.lineJoin = 'miter';
    const seg = (x1, y1, x2, y2) => { c.moveTo(x + x1, y + y1); c.lineTo(x + x2, y + y2); };
    const stroke = (build) => {
      if (o.outline) { c.beginPath(); build(); c.strokeStyle = '#000'; c.lineWidth = t + 2; c.stroke(); }
      c.beginPath(); build(); c.strokeStyle = o.color; c.lineWidth = t; c.stroke();
    };
    const dot = (r) => {
      if (o.outline) { c.beginPath(); c.arc(x, y, r + 1, 0, Math.PI * 2); c.fillStyle = '#000'; c.fill(); }
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = o.color; c.fill();
    };
    const cross = (top) => stroke(() => {
      if (top) seg(0, -g, 0, -g - s);
      seg(0, g, 0, g + s); seg(-g, 0, -g - s, 0); seg(g, 0, g + s, 0);
    });
    const ring = () => stroke(() => c.arc(x, y, Math.max(3, g + s * 0.6), 0, Math.PI * 2));
    const centerDot = () => dot(Math.max(1.2, t * 0.8));
    switch (o.shape) {
      case 'cross': cross(true); break;
      case 'crossdot': cross(true); centerDot(); break;
      case 'tshape': cross(false); break;
      case 'x': {
        const d = Math.SQRT1_2;
        stroke(() => {
          seg(g * d, g * d, (g + s) * d, (g + s) * d); seg(-g * d, g * d, -(g + s) * d, (g + s) * d);
          seg(g * d, -g * d, (g + s) * d, -(g + s) * d); seg(-g * d, -g * d, -(g + s) * d, -(g + s) * d);
        });
        break;
      }
      case 'dot': dot(Math.max(1.5, s / 3)); break;
      case 'circle': ring(); break;
      case 'circledot': ring(); centerDot(); break;
      case 'chevron': stroke(() => { c.moveTo(x - s, y + g + s * 0.7); c.lineTo(x, y + g); c.lineTo(x + s, y + g + s * 0.7); }); break;
      case 'square': { const h = g + s / 2; stroke(() => c.rect(x - h, y - h, h * 2, h * 2)); break; }
      case 'triangle': {
        const r = g + s * 0.6;
        stroke(() => {
          for (let i = 0; i < 3; i++) {
            const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
            if (i === 0) c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
          }
          c.closePath();
        });
        break;
      }
      default: cross(true);
    }
    c.restore();
  }

  const xhPreview = $('xhairPreview'), xpc = xhPreview.getContext('2d');
  function drawXhairPreview() {
    const dpr = window.devicePixelRatio || 1;
    if (xhPreview.width !== 140 * dpr) { xhPreview.width = 140 * dpr; xhPreview.height = 140 * dpr; }
    xpc.setTransform(dpr, 0, 0, dpr, 0, 0);
    xpc.fillStyle = '#718c5a'; xpc.fillRect(0, 0, 140, 140);
    xpc.fillStyle = '#6a8453'; xpc.fillRect(70, 0, 70, 140);
    drawCrosshair(xpc, 70, 70, xh);
  }
  function saveXhair() {
    try { localStorage.setItem('lax.crosshair', JSON.stringify(xh)); } catch { /* not saved */ }
    drawXhairPreview();
  }
  function syncXhairUI() {
    $('xhShape').value = xh.shape;
    $('xhSize').value = xh.size; $('xhThick').value = xh.thick; $('xhGap').value = xh.gap;
    $('xhAlpha').value = xh.alpha; $('xhSens').value = xh.sens; $('xhOutline').checked = xh.outline;
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === xh.color));
    drawXhairPreview();
  }
  for (const col of XH_COLORS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.dataset.c = col; b.style.background = col; b.title = col;
    b.addEventListener('click', () => { xh.color = col; syncXhairUI(); saveXhair(); });
    $('xhColors').appendChild(b);
  }
  $('xhShape').addEventListener('change', (e) => { xh.shape = e.target.value; saveXhair(); });
  for (const [id, key] of [['xhSize', 'size'], ['xhThick', 'thick'], ['xhGap', 'gap'], ['xhAlpha', 'alpha'], ['xhSens', 'sens']]) {
    $(id).addEventListener('input', (e) => { xh[key] = parseFloat(e.target.value); saveXhair(); });
  }
  $('xhOutline').addEventListener('change', (e) => { xh.outline = e.target.checked; saveXhair(); });
  $('xhReset').addEventListener('click', () => { xh = { ...XH_DEFAULT }; syncXhairUI(); saveXhair(); });
  syncXhairUI();

  let lockHintShown = false;
  function updateLockHint() {
    const show = canLockAim() && !pointerLocked && !touchMode && aimSource === 'mouse';
    if (show !== lockHintShown) { lockHintShown = show; $('lockHint').classList.toggle('hidden', !show); }
  }

  function frame() {
    requestAnimationFrame(frame);
    computeView();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2b3626';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!cfg) { drawIdle(); return; }
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);

    pollPad();
    sendMove();
    const playing = room.state === 'playing';
    let st = playing ? stateAt() : null;
    drawField(st);
    drawGoals();
    if (st) {
      let me = sendAim(st);
      if (me && turnPct > 0) { st = predictOwnStick(st, me); me = st.p.find((p) => p[0] === myId); }
      for (const p of st.p) drawStick(p);
      for (const p of st.p) drawPlayer(p, roster.get(p[0]));
      drawBall(st.b);
      for (const p of st.p) { drawCharge(p); drawName(p, roster.get(p[0])); }
      drawFlashes(performance.now());
      updateHud(st);
      if (me && roomScreen.classList.contains('hidden')) {
        // faint ring when the crosshair is held at the edge of the aim radius
        const R = aimRadius();
        if (Math.hypot(aimOff.x, aimOff.y) >= R - 1) {
          ctx.beginPath(); ctx.arc(me[1], me[2], R, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.stroke();
        }
        const s = toScreen(me[1] + aimOff.x, me[2] + aimOff.y);
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        drawCrosshair(ctx, s.x, s.y, xh);
      }
    } else {
      drawBall([0, 0]);
    }
    updateLockHint();
    updateTouchLayer();
    if (touchMode) updateAimShoot();
  }

  // Draw your own stick from your local aim instead of waiting for the server's copy, so it reacts
  // without network delay. At 100% it points straight at your aim; in between it's a blend.
  function predictOwnStick(st, me) {
    const local = Math.atan2(aimOff.y, aimOff.x);
    if (Math.hypot(aimOff.x, aimOff.y) < 0.5) return st;
    const ang = lerpAngle(me[3], local, turnPct / 100);
    const p = st.p.map((q) => (q[0] === myId ? [q[0], q[1], q[2], ang, q[4], q[5]] : q));
    let b = st.b;
    if (b[2] === myId) {
      b = [me[1] + Math.cos(ang) * cfg.pocketDist, me[2] + Math.sin(ang) * cfg.pocketDist, myId];
      b[0] = Math.max(-cfg.hw + cfg.ballR, Math.min(cfg.hw - cfg.ballR, b[0]));
      b[1] = Math.max(-cfg.hh + cfg.ballR, Math.min(cfg.hh - cfg.ballR, b[1]));
    }
    return { ...st, p, b };
  }

  // ---------- stick response setting ----------
  function showTurn() {
    $('optTurn').value = turnPct;
    $('optTurnVal').textContent = turnPct === 0 ? 'smooth' : turnPct === 100 ? 'instant' : turnPct + '%';
  }
  $('optTurn').addEventListener('input', (e) => {
    turnPct = parseInt(e.target.value, 10) || 0;
    try { localStorage.setItem('lax.turn', String(turnPct)); } catch { /* not saved */ }
    showTurn();
    send({ t: 'turn', v: turnPct / 100 });
  });
  showTurn();

  // ---------- analog movement (controller / touch) ----------
  function sendMove() {
    const v = (touchMove.x || touchMove.y) ? touchMove : padMove;
    const q = (n) => Math.round(n * 20) / 20;
    const key = q(v.x) + ',' + q(v.y);
    if (key !== lastMoveSent) { lastMoveSent = key; send({ t: 'move', x: q(v.x), y: q(v.y) }); }
  }

  // ---------- game controller (PS4 / Xbox / any standard pad) ----------
  // Left stick = move, right stick = aim, R1 = throw (hold to charge), L1 = check, Options = menu.
  const DEAD = 0.18;
  let padIndex = null, padPrevButtons = [];
  function padToast(text) {
    const t = $('padToast'); t.textContent = text; t.classList.remove('hidden');
    clearTimeout(padToast.timer); padToast.timer = setTimeout(() => t.classList.add('hidden'), 2500);
  }
  function setPadStatus(gp) {
    $('padStatus').textContent = gp
      ? `🎮 Controller connected: ${gp.id.replace(/\(.*?\)/g, '').trim() || 'gamepad'} — left stick move · right stick aim · R1 throw · L1 check · Options menu`
      : '🎮 No controller detected — plug in a PS4 controller and press any button';
  }
  window.addEventListener('gamepadconnected', (e) => { padIndex = e.gamepad.index; setPadStatus(e.gamepad); padToast('🎮 Controller connected'); });
  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index !== padIndex) return;
    padIndex = null; padBits = 0; padMove = { x: 0, y: 0 }; pushInput(); setPadStatus(null); padToast('🎮 Controller disconnected');
  });
  function stick(x, y) {
    const m = Math.hypot(x, y);
    if (m < DEAD) return { x: 0, y: 0, m: 0 };
    const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;   // rescale so the dead zone edge is 0
    return { x: x * k, y: y * k, m: Math.min(1, (m - DEAD) / (1 - DEAD)) };
  }
  function pollPad() {
    if (!navigator.getGamepads) return;
    if (padIndex === null) {
      // some browsers only announce a controller once a button is pressed; also pick up one that's already there
      const found = Array.from(navigator.getGamepads()).find((g) => g && g.connected);
      if (!found) return;
      padIndex = found.index; setPadStatus(found);
    }
    const gp = navigator.getGamepads()[padIndex];
    if (!gp) return;
    const ax = gp.axes, bt = gp.buttons;
    // "standard" layout: right stick on axes 2/3. Some Linux browsers report raw layouts (right stick on 3/4).
    const rIdx = gp.mapping === 'standard' || ax.length < 5 ? [2, 3] : [3, 4];
    const L = stick(ax[0] || 0, ax[1] || 0), R = stick(ax[rIdx[0]] || 0, ax[rIdx[1]] || 0);
    const pressed = (i) => !!(bt[i] && (bt[i].pressed || bt[i].value > 0.5));
    const inGame = room.state === 'playing' && roomScreen.classList.contains('hidden') && !chatOpen;

    // Options (9) opens/closes the room menu
    if (pressed(9) && !padPrevButtons[9] && room.state === 'playing') {
      roomScreen.classList.toggle('hidden'); releaseKeys(); unlockAim();
    }
    padPrevButtons = bt.map((b) => !!(b && b.pressed));

    padMove = inGame ? { x: L.x, y: L.y } : { x: 0, y: 0 };
    const bits = inGame ? (pressed(5) ? 16 : 0) | (pressed(4) ? 32 : 0) : 0;
    if (inGame && (L.m > 0 || R.m > 0 || bits) && aimSource !== 'pad') { aimSource = 'pad'; unlockAim(); updateAimMode(); }
    if (inGame && R.m > 0.25) {
      const a = Math.atan2(R.y, R.x);
      aimOff.x = Math.cos(a) * PAD_AIM_DIST; aimOff.y = Math.sin(a) * PAD_AIM_DIST;
    }
    if (bits !== padBits) { padBits = bits; pushInput(); }
  }

  // ---------- touch controls (phones / tablets) ----------
  // Left half: a joystick appears wherever your thumb lands and moves you. Right half: same, for aiming.
  // Aim stick extras: drag past its outer ring while you have the ball to start charging a shot, let go to
  // throw (the longer you hold out there, the harder). Double-tap the right side to check.
  const TOUCH_R = 60;
  const DOUBLE_TAP_MS = 320, TAP_MAX_MS = 250, TAP_MAX_MOVE = 14;
  let lastAimTap = 0;
  const iHaveBall = () => snaps.length > 0 && snaps[snaps.length - 1].b[2] === myId;
  function setShoot(on) {
    const bits = on ? 16 : 0;
    if ((touchBits & 16) !== bits) { touchBits = (touchBits & ~16) | bits; pushInput(); }
  }
  function pulseCheck() {
    touchBits |= 32; pushInput();
    setTimeout(() => { touchBits &= ~32; pushInput(); }, 120);   // the server checks on the press
  }
  // Called every frame so catching the ball while your thumb is already past the ring starts the charge too.
  function updateAimShoot() {
    const s = touchSticks.aim;
    const want = !!(s && s.beyond && (iHaveBall() || (touchBits & 16)));
    setShoot(want);
    if (s) s.base.classList.toggle('armed', want);
  }
  const touchSticks = {};
  function enableTouch() {
    if (touchMode) return;
    touchMode = true;
    document.body.classList.add('touch');
    aimSource = 'touch'; mouseAim = true; unlockAim(); updateAimMode();
  }
  window.addEventListener('touchstart', enableTouch, { passive: true });
  function updateTouchLayer() {
    const show = touchMode && room.state === 'playing' && roomScreen.classList.contains('hidden') && !chatOpen;
    if (show === updateTouchLayer.shown) return;
    updateTouchLayer.shown = show;
    $('touchLayer').classList.toggle('hidden', !show);
    if (!show) resetTouch();
  }
  function resetTouch() {
    for (const k of Object.keys(touchSticks)) endStick(k);
    touchBits = 0; pushInput();
  }
  function setupStick(zoneId, kind) {
    const zone = $(zoneId), base = zone.querySelector('.tbase'), knob = zone.querySelector('.tknob');
    zone.addEventListener('pointerdown', (e) => {
      if (touchSticks[kind]) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      touchSticks[kind] = { id: e.pointerId, ox: e.clientX, oy: e.clientY, base, knob, zone, t0: performance.now(), maxD: 0, beyond: false };
      base.style.left = (e.clientX - r.left) + 'px'; base.style.top = (e.clientY - r.top) + 'px';
      knob.style.transform = 'translate(0px, 0px)';
      base.classList.add('on');
      if (kind === 'aim') aimSource = 'touch';
    });
    zone.addEventListener('pointermove', (e) => {
      const s = touchSticks[kind];
      if (!s || s.id !== e.pointerId) return;
      let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
      const d = Math.hypot(dx, dy);
      s.maxD = Math.max(s.maxD, d);
      if (kind === 'aim') s.beyond = d > TOUCH_R;
      if (d > TOUCH_R) { dx *= TOUCH_R / d; dy *= TOUCH_R / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const v = stick(dx / TOUCH_R, dy / TOUCH_R);
      if (kind === 'move') touchMove = { x: v.x, y: v.y };
      else {
        if (v.m > 0.15) {
          const a = Math.atan2(dy, dx);
          aimOff.x = Math.cos(a) * PAD_AIM_DIST; aimOff.y = Math.sin(a) * PAD_AIM_DIST;
        }
        updateAimShoot();
      }
    });
    const end = (e) => {
      const s = touchSticks[kind];
      if (!s || s.id !== e.pointerId) return;
      if (kind === 'aim' && e.type === 'pointerup') {
        const now = performance.now();
        const isTap = now - s.t0 < TAP_MAX_MS && s.maxD < TAP_MAX_MOVE;
        if (isTap && now - lastAimTap < DOUBLE_TAP_MS) { pulseCheck(); lastAimTap = 0; }
        else lastAimTap = isTap ? now : 0;
      }
      endStick(kind);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }
  function endStick(kind) {
    const s = touchSticks[kind];
    if (!s) return;
    s.base.classList.remove('on', 'armed');
    delete touchSticks[kind];
    if (kind === 'move') touchMove = { x: 0, y: 0 };   // aim keeps its last direction
    else setShoot(false);                               // letting go of a charged aim stick throws
  }
  setupStick('tzLeft', 'move');
  setupStick('tzRight', 'aim');
  $('touchMenu').addEventListener('click', () => { roomScreen.classList.remove('hidden'); releaseKeys(); });
  $('chatBtn').addEventListener('click', () => { if (room.state === 'playing') roomScreen.classList.add('hidden'); openChat(); });

  function drawIdle() {
    // decorative field behind the join screen
    cfg = null;
    const fake = { pmx: 600, pmy: 325, hw: 560, hh: 290, restrainX: 330, centerR: 75, goalX: 450, creaseOff: 10, creaseR: 64, postY: 42, goalDepth: 34, postR: 4, ballR: 6 };
    const W = canvas.width, H = canvas.height;
    const scale = Math.min(W / 1230, H / 680);
    ctx.setTransform(scale, 0, 0, scale, W / 2, H / 2);
    cfg = fake; drawField(null); drawGoals(); drawBall([0, 0]); cfg = null;
  }
  requestAnimationFrame(frame);
})();
