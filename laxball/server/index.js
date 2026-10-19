'use strict';
// LaxBall server: serves the web client and runs one shared game room over WebSockets.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, CFG, PHYS } = require('./game');

const PORT = parseInt(process.env.PORT || '7777', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const game = new Game();
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const clients = new Map(); // ws -> playerId
let adminId = null;

function send(ws, msg) { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) send(ws, data);
}
function sysChat(m) { broadcast({ t: 'chat', sys: true, m }); }
function pickAdmin() {
  if (adminId && game.players.has(adminId)) return;
  const humans = [...game.players.values()].filter((p) => !p.bot).sort((a, b) => a.id - b.id);
  adminId = humans.length ? humans[0].id : null;
  if (adminId) sysChat(`${game.players.get(adminId).name} is now the room admin.`);
  game.rosterDirty = true;
}
function cleanText(s, max) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}
function cleanAvatar(s) {
  return Array.from(cleanText(s, 12)).slice(0, 2).join('');
}

wss.on('connection', (ws) => {
  let me = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (me) return;
      const name = cleanText(m.name, 20) || 'Player';
      me = game.addPlayer(name, cleanAvatar(m.avatar) || name.slice(0, 1).toUpperCase(), false);
      clients.set(ws, me.id);
      send(ws, { t: 'welcome', id: me.id, cfg: CFG, phys: { checkTicks: PHYS.checkTicks } });
      sysChat(`${name} joined.`);
      pickAdmin();
      return;
    }
    if (!me) return;
    const isAdmin = me.id === adminId;

    switch (m.t) {
      case 'input':
        me.input = (m.k | 0) & 63;
        break;
      case 'aim':
        if (typeof m.a === 'number' && isFinite(m.a)) me.aim = m.a;
        break;
      case 'aimMode':
        me.aimMode = !!m.on;
        if (typeof m.a === 'number' && isFinite(m.a)) me.aim = m.a; else me.aim = me.angle;
        break;
      case 'chat': {
        const text = cleanText(m.m, 140);
        if (!text) break;
        if (text.startsWith('/avatar')) {
          me.avatar = cleanAvatar(text.slice(7)) || me.name.slice(0, 1).toUpperCase();
          game.rosterDirty = true;
          send(ws, { t: 'chat', sys: true, m: `Avatar set to "${me.avatar}".` });
        } else {
          broadcast({ t: 'chat', from: me.name, team: me.team, m: text });
        }
        break;
      }
      case 'team': {
        const id = m.id | 0, team = m.team | 0;
        if (id === me.id || isAdmin) game.setTeam(id, team);
        break;
      }
      case 'start':
        if (isAdmin && game.start()) sysChat('Game started. Good luck!');
        break;
      case 'stop':
        if (isAdmin && game.state === 'playing') { game.stop(); sysChat('Game stopped.'); }
        break;
      case 'pause':
        if (isAdmin && game.state === 'playing') {
          game.paused = !game.paused;
          sysChat(game.paused ? 'Game paused.' : 'Game resumed.');
          game.rosterDirty = true;
        }
        break;
      case 'settings':
        if (isAdmin && game.state === 'lobby') {
          const sl = m.scoreLimit | 0, tl = m.timeLimit | 0;
          if (sl >= 0 && sl <= 20) game.settings.scoreLimit = sl;
          if (tl >= 0 && tl <= 20) game.settings.timeLimit = tl;
          game.rosterDirty = true;
        }
        break;
      case 'addBot':
        if (isAdmin && (m.team === 1 || m.team === 2) && game.players.size < 24) game.addBot(m.team);
        break;
      case 'removeBots':
        if (isAdmin) game.removeBots();
        break;
      case 'kick': {
        const target = game.players.get(m.id | 0);
        if (!isAdmin || !target || target.id === me.id) break;
        if (target.bot) { game.removePlayer(target.id); break; }
        for (const [sock, pid] of clients) if (pid === target.id) { send(sock, { t: 'kicked' }); sock.close(); }
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', c: m.c });
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (me) {
      game.removePlayer(me.id);
      sysChat(`${me.name} left.`);
      if (adminId === me.id) { adminId = null; pickAdmin(); }
      if (![...game.players.values()].some((p) => !p.bot)) {
        // nobody left: reset the room
        game.stop();
        game.removeBots();
      }
    }
  });
});

// Fixed-step game loop. setInterval drifts, so catch up based on real time.
const STEP_MS = 1000 / CFG.tickRate;
let last = performance.now(), acc = 0, loopCount = 0;
setInterval(() => {
  const now = performance.now();
  acc += now - last; last = now;
  if (acc > 250) acc = 250;
  while (acc >= STEP_MS) {
    acc -= STEP_MS;
    const wasPlaying = game.state === 'playing';
    game.step();
    for (const m of game.messages) sysChat(m);
    loopCount++;
    if (game.state === 'playing') {
      // while paused, a slow heartbeat is enough
      if (!game.paused || loopCount % 30 === 0) broadcast(game.snapshot());
    } else if (wasPlaying) {
      game.rosterDirty = true;
    }
    if (game.rosterDirty) { game.rosterDirty = false; broadcast(game.roster(adminId)); }
  }
}, 4);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LaxBall running on http://0.0.0.0:${PORT}`);
});
