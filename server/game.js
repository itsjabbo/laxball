'use strict';
// LaxBall — authoritative game simulation (runs at 60 ticks per second).
// All distances are in field units (roughly pixels at 1x zoom); velocities are units per tick.

const { botThink } = require('./bot');

const { CFG, PHYS, TEAM_SPEC, TEAM_RED, TEAM_BLUE, defSide, SPAWNS, GOALS } = require('./constants');

// ---------- small math helpers ----------
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function inTriangle(px, py, a, b, c) {
  const d1 = (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
  const d2 = (px - c.x) * (b.y - c.y) - (b.x - c.x) * (py - c.y);
  const d3 = (px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
// Dynamic circle vs circle. Returns impact speed (0 if no collision).
function collideCircles(a, b, bCoef) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.r + b.r, d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0) return 0;
  const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
  const total = a.invMass + b.invMass;
  if (total === 0) return 0;
  const overlap = rr - d;
  a.x -= nx * overlap * (a.invMass / total); a.y -= ny * overlap * (a.invMass / total);
  b.x += nx * overlap * (b.invMass / total); b.y += ny * overlap * (b.invMass / total);
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    const j = (-(1 + bCoef) * rv) / total;
    a.vx -= j * nx * a.invMass; a.vy -= j * ny * a.invMass;
    b.vx += j * nx * b.invMass; b.vy += j * ny * b.invMass;
    return -rv;
  }
  return 0.0001;
}
// Circle vs a fixed segment. Returns impact speed (0 if no collision).
function collideSegment(c, s, bCoef) {
  const sx = s.x2 - s.x1, sy = s.y2 - s.y1;
  const len2 = sx * sx + sy * sy;
  let t = ((c.x - s.x1) * sx + (c.y - s.y1) * sy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = s.x1 + sx * t, py = s.y1 + sy * t;
  const dx = c.x - px, dy = c.y - py, d2 = dx * dx + dy * dy;
  if (d2 >= c.r * c.r) return 0;
  let d = Math.sqrt(d2), nx, ny;
  if (d < 1e-6) { nx = -sy / Math.sqrt(len2); ny = sx / Math.sqrt(len2); d = 0; }
  else { nx = dx / d; ny = dy / d; }
  c.x = px + nx * c.r; c.y = py + ny * c.r;
  const vn = c.vx * nx + c.vy * ny;
  if (vn < 0) { c.vx -= (1 + bCoef) * vn * nx; c.vy -= (1 + bCoef) * vn * ny; return -vn; }
  return 0.0001;
}
function collideFixedCircle(c, fx, fy, fr, bCoef) {
  return collideCircles({ x: fx, y: fy, vx: 0, vy: 0, r: fr, invMass: 0 }, c, bCoef);
}
function pushOutOfCircle(p, cx, cy, R) {
  const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
  if (d >= R) return false;
  const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
  p.x = cx + nx * R; p.y = cy + ny * R;
  const vn = p.vx * nx + p.vy * ny;
  if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
  return true;
}
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const BOT_NAMES = ['Rex', 'Duke', 'Ace', 'Blitz', 'Moose', 'Nova', 'Tank', 'Viper', 'Jinx', 'Bolt', 'Zed', 'Ivy'];

class Game {
  constructor() {
    this.players = new Map();
    this.nextId = 1;
    this.ball = { x: 0, y: 0, vx: 0, vy: 0, r: CFG.ballR, invMass: PHYS.ballInvMass, carrier: 0, lastTouch: 0, prevTouch: 0 };
    this.state = 'lobby';
    this.phase = 'kickoff';
    this.phaseTimer = 0;
    this.kickoffTeam = TEAM_RED;
    this.score = [0, 0];
    this.time = 0;
    this.overtime = false;
    this.paused = false;
    this.settings = { scoreLimit: 3, timeLimit: 3 };
    this.tick = 0;
    this.events = [];
    this.messages = [];     // system chat lines produced during a step
    this.rosterDirty = true;
    this.botCount = 0;
    this.lastPostSound = 0;
  }

  // ---------- roster ----------
  addPlayer(name, avatar, bot = false) {
    const id = this.nextId++;
    const p = {
      id, name, avatar, bot, team: TEAM_SPEC, joinOrder: id,
      x: 0, y: 0, vx: 0, vy: 0, r: CFG.playerR, invMass: PHYS.playerInvMass,
      angle: 0, input: 0, prevInput: 0, aimMode: bot, aim: 0,
      turn: 0, moveX: 0, moveY: 0,   // turn: 0 = smoothed stick, 1 = instant; move: analog stick (-1..1)
      charge: 0, charging: false, noCatch: 0, checkCd: 0, swing: 0, protect: 0, botState: null,
    };
    this.players.set(id, p);
    this.rosterDirty = true;
    return p;
  }
  addBot(team) {
    const name = 'Bot ' + BOT_NAMES[this.botCount++ % BOT_NAMES.length];
    const p = this.addPlayer(name, '🤖', true);
    this.setTeam(p.id, team);
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.ball.carrier === id) this.dropBall();
    this.players.delete(id);
    this.rosterDirty = true;
  }
  removeBots() {
    for (const p of [...this.players.values()]) if (p.bot) this.removePlayer(p.id);
  }
  setTeam(id, team) {
    const p = this.players.get(id);
    if (!p || ![0, 1, 2].includes(team) || p.team === team) return;
    if (this.ball.carrier === id) this.dropBall();
    p.team = team;
    p.joinOrder = this.nextId++;
    p.charge = 0; p.charging = false; p.swing = 0;
    if (this.state === 'playing' && team !== TEAM_SPEC) this.spawnPlayer(p, this.teamPlayers(team).length - 1);
    this.rosterDirty = true;
  }
  teamPlayers(team) {
    return [...this.players.values()].filter((p) => p.team === team).sort((a, b) => a.joinOrder - b.joinOrder);
  }
  activePlayers() {
    return [...this.players.values()].filter((p) => p.team !== TEAM_SPEC);
  }

  // ---------- game flow ----------
  start() {
    if (this.state === 'playing') return false;
    if (this.activePlayers().length === 0) return false;
    this.state = 'playing';
    this.score = [0, 0];
    this.time = 0;
    this.overtime = false;
    this.paused = false;
    this.kickoffTeam = TEAM_RED;
    this.resetPositions();
    this.rosterDirty = true;
    this.events.push({ e: 'whistle' });
    return true;
  }
  stop() {
    if (this.state !== 'playing') return;
    this.state = 'lobby';
    this.paused = false;
    this.ball.carrier = 0;
    this.rosterDirty = true;
  }
  spawnPlayer(p, index) {
    const s = SPAWNS[index] || [-200 - (index - SPAWNS.length) * 30, ((index % 2) ? -1 : 1) * 60];
    const mirror = p.team === TEAM_RED ? 1 : -1;
    p.x = s[0] * mirror; p.y = s[1];
    p.vx = 0; p.vy = 0;
    p.angle = p.team === TEAM_RED ? 0 : Math.PI;
    if (p.aimMode && !p.bot) p.aim = p.angle;
    p.charge = 0; p.charging = false; p.noCatch = 0; p.swing = 0; p.checkCd = 0;
    if (p.botState) p.botState = null;
  }
  resetPositions() {
    for (const team of [TEAM_RED, TEAM_BLUE]) this.teamPlayers(team).forEach((p, i) => this.spawnPlayer(p, i));
    const b = this.ball;
    b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.carrier = 0; b.lastTouch = 0; b.prevTouch = 0;
    this.phase = 'kickoff';
  }
  // Any contact with the ball ends the kickoff. Only catches and throws count as possession,
  // which decides who gets credit for a goal (a shot that deflects in off a defender is still yours).
  touch(p, possess = false) {
    const b = this.ball;
    if (possess && b.lastTouch !== p.id) { b.prevTouch = b.lastTouch; b.lastTouch = p.id; }
    if (this.phase === 'kickoff') this.phase = 'play';
  }
  dropBall() {
    const b = this.ball;
    const c = this.players.get(b.carrier);
    b.carrier = 0;
    if (c) { c.charging = false; c.charge = 0; }
  }

  // ---------- one simulation tick ----------
  step() {
    this.events = [];
    this.messages = [];
    if (this.state !== 'playing' || this.paused) return;
    this.tick++;
    const b = this.ball;
    const active = this.activePlayers();

    for (const p of active) if (p.bot) botThink(this, p, active);

    // 1. players: input, movement, facing, throwing, checking
    for (const p of active) this.updatePlayer(p);

    // 2. stick checks (only against an opposing ball carrier)
    const carrier = b.carrier ? this.players.get(b.carrier) : null;
    if (carrier) {
      for (const p of active) {
        if (p.swing <= 0 || p.team === carrier.team || carrier.protect > 0) continue;
        const head = this.stickHead(p);
        if (Math.hypot(head.x - b.x, head.y - b.y) < PHYS.checkHitR) {
          this.dislodge(carrier, p);
          break;
        }
      }
    }

    // 3. player collisions & constraints
    for (let i = 0; i < active.length; i++)
      for (let j = i + 1; j < active.length; j++) collideCircles(active[i], active[j], 0.5);
    for (const p of active) this.constrainPlayer(p);

    // 4. ball
    if (b.carrier) {
      const c = this.players.get(b.carrier);
      if (!c || c.team === TEAM_SPEC) b.carrier = 0;
      else this.attachBall(c);
    }
    let goalSide = 0;
    if (!b.carrier) {
      // Move in small sub-steps so a fast ball can't skip through the cage's thin back wall,
      // and only count a goal when the ball crosses the goal line between the posts from the field side.
      const speed = Math.hypot(b.vx, b.vy);
      const n = Math.max(1, Math.ceil(speed / (CFG.ballR * 0.5)));
      for (let i = 0; i < n && !goalSide; i++) {
        const px = b.x, py = b.y;
        b.x += b.vx / n; b.y += b.vy / n;
        goalSide = this.crossedGoalLine(px, py, b.x, b.y);
        if (!goalSide) this.collideBallStatic();
      }
      b.vx *= PHYS.bDamp; b.vy *= PHYS.bDamp;
      if (!goalSide) {
        this.tryCatch(active);
        if (!b.carrier) this.collideLooseBall(active);
      }
    }

    // 5. goals
    if (goalSide && (this.phase === 'play' || this.phase === 'kickoff')) this.goalScored(goalSide);

    // 6. clock & phases
    if (this.phase === 'play') {
      this.time++;
      const limit = this.settings.timeLimit * 60 * CFG.tickRate;
      if (limit > 0 && this.time >= limit && !this.overtime) {
        if (this.score[0] !== this.score[1]) this.endGame();
        else { this.overtime = true; this.events.push({ e: 'overtime' }); this.messages.push('Overtime! Next goal wins.'); }
      }
    } else if (this.phase === 'goal') {
      if (--this.phaseTimer <= 0) {
        const sl = this.settings.scoreLimit;
        if (this.overtime || (sl > 0 && (this.score[0] >= sl || this.score[1] >= sl))) this.endGame();
        else { this.resetPositions(); this.events.push({ e: 'whistle' }); }
      }
    } else if (this.phase === 'over') {
      if (--this.phaseTimer <= 0) this.stop();
    }

    for (const p of active) p.prevInput = p.input;
  }

  updatePlayer(p) {
    const b = this.ball;
    const inp = p.input;
    const dx = ((inp & 8) ? 1 : 0) - ((inp & 4) ? 1 : 0);
    const dy = ((inp & 2) ? 1 : 0) - ((inp & 1) ? 1 : 0);
    const hasBall = b.carrier === p.id;
    const throwDown = (inp & 16) !== 0;

    if (p.noCatch > 0) p.noCatch--;
    if (p.checkCd > 0) p.checkCd--;
    if (p.swing > 0) p.swing--;
    if (p.protect > 0) p.protect--;

    if (hasBall && throwDown && this.phase !== 'over') {
      if (!p.charging) { p.charging = true; p.charge = 0; }
      p.charge = Math.min(1, p.charge + 1 / PHYS.chargeTicks);
    }

    let accel = PHYS.accel;
    if (hasBall) accel = PHYS.accelCarry;
    if (p.charging) accel = PHYS.accelCharge;
    if (p.swing > 0) accel = PHYS.accelSwing;
    if (dx || dy) {
      const l = Math.hypot(dx, dy);
      p.vx += (dx / l) * accel; p.vy += (dy / l) * accel;
    } else if (p.moveX || p.moveY) {
      // analog stick (controller / touch): a partly-pushed stick moves you more slowly
      const m = Math.hypot(p.moveX, p.moveY), k = Math.min(1, m) / m;
      p.vx += p.moveX * k * accel; p.vy += p.moveY * k * accel;
    }
    p.vx *= PHYS.pDamp; p.vy *= PHYS.pDamp;
    p.x += p.vx; p.y += p.vy;

    let target = null;
    if (p.aimMode) target = p.aim;
    else if (dx || dy) target = Math.atan2(dy, dx);
    if (target !== null) {
      const rate = PHYS.turnRate + (1 - PHYS.turnRate) * p.turn; // turn 1 = stick snaps straight to the aim
      p.angle = normAngle(lerpAngle(p.angle, target, rate));
    }

    if (p.charging && !throwDown) {
      if (hasBall) this.throwBall(p);
      p.charging = false; p.charge = 0;
    }
    if (!hasBall && p.charging) { p.charging = false; p.charge = 0; }

    const checkDown = (inp & 32) !== 0;
    if (checkDown && !(p.prevInput & 32) && p.checkCd === 0 && !hasBall) {
      p.swing = PHYS.checkTicks; p.checkCd = PHYS.checkCd;
      this.events.push({ e: 'swing', id: p.id });
    }
  }

  stickHead(p) {
    // During a check the stick sweeps across the front of the player.
    let a = p.angle, dist = CFG.pocketDist;
    if (p.swing > 0) {
      const t = 1 - p.swing / PHYS.checkTicks;
      a += (0.5 - t) * 2.2;
      dist += 6;
    }
    return { x: p.x + Math.cos(a) * dist, y: p.y + Math.sin(a) * dist };
  }

  throwBall(p) {
    const b = this.ball;
    const c = p.charge;
    const speed = PHYS.throwMin + (PHYS.throwMax - PHYS.throwMin) * c;
    const ux = Math.cos(p.angle), uy = Math.sin(p.angle);
    b.carrier = 0;
    b.x = p.x + ux * CFG.pocketDist; b.y = p.y + uy * CFG.pocketDist;
    b.vx = ux * speed + p.vx * 0.5; b.vy = uy * speed + p.vy * 0.5;
    p.noCatch = 16;
    this.touch(p, true);
    this.events.push({ e: 'throw', id: p.id, power: r2(c) });
  }

  dislodge(carrier, checker) {
    const b = this.ball;
    let dx = b.x - checker.x, dy = b.y - checker.y;
    const l0 = Math.hypot(dx, dy) || 1;
    // push the ball away from the checker and along the direction of the swing
    const sa = checker.angle - Math.PI / 2;
    dx = dx / l0 + Math.cos(sa) * 0.6;
    dy = dy / l0 + Math.sin(sa) * 0.6;
    const l = Math.hypot(dx, dy) || 1;
    b.carrier = 0;
    b.vx = (dx / l) * 4.2 + carrier.vx * 0.5;
    b.vy = (dy / l) * 4.2 + carrier.vy * 0.5;
    carrier.charging = false; carrier.charge = 0;
    carrier.noCatch = 40;
    checker.noCatch = 5;
    checker.swing = 0;
    this.events.push({ e: 'check', id: checker.id, victim: carrier.id });
  }

  attachBall(c) {
    const b = this.ball;
    b.x = c.x + Math.cos(c.angle) * CFG.pocketDist;
    b.y = c.y + Math.sin(c.angle) * CFG.pocketDist;
    b.x = Math.max(-CFG.hw + b.r, Math.min(CFG.hw - b.r, b.x));
    b.y = Math.max(-CFG.hh + b.r, Math.min(CFG.hh - b.r, b.y));
    b.vx = c.vx; b.vy = c.vy;

    // A carried ball may never end up inside a cage (only defenders standing behind it could manage that).
    for (const side of [-1, 1]) {
      const g = GOALS[side];
      if (inTriangle(b.x, b.y, g.top, g.bot, g.apex)) {
        this.dropBall();
        b.x = c.x; b.y = c.y;
        b.vx = -c.vx; b.vy = -c.vy;
        c.noCatch = 20;
        return;
      }
    }
    // Carrying the ball over the field lines is a turnover.
    if (Math.abs(c.x) > CFG.hw + 4 || Math.abs(c.y) > CFG.hh + 4) {
      this.dropBall();
      b.x = Math.max(-CFG.hw + 20, Math.min(CFG.hw - 20, c.x));
      b.y = Math.max(-CFG.hh + 20, Math.min(CFG.hh - 20, c.y));
      b.vx = 0; b.vy = 0;
      for (const q of this.teamPlayers(c.team)) q.noCatch = Math.max(q.noCatch, 45);
      c.noCatch = 90;
      this.events.push({ e: 'out', id: c.id });
      this.messages.push(`${c.name} stepped out of bounds — turnover!`);
    }
  }

  tryCatch(active) {
    const b = this.ball;
    let best = null, bd = Infinity;
    for (const p of active) {
      if (p.noCatch > 0) continue;
      const hx = p.x + Math.cos(p.angle) * CFG.pocketDist, hy = p.y + Math.sin(p.angle) * CFG.pocketDist;
      const d = Math.hypot(hx - b.x, hy - b.y);
      if (d < CFG.catchR && d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    const rel = Math.hypot(b.vx - best.vx, b.vy - best.vy);
    if (rel <= PHYS.catchMaxSpeed) {
      b.carrier = best.id;
      best.protect = PHYS.catchProtect;
      this.touch(best, true);
      this.attachBall(best);
      this.events.push({ e: 'catch', id: best.id });
    } else {
      // too hot to handle: it rattles off the stick head
      const hx = best.x + Math.cos(best.angle) * CFG.pocketDist, hy = best.y + Math.sin(best.angle) * CFG.pocketDist;
      let nx = b.x - hx, ny = b.y - hy;
      const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const vn = (b.vx - best.vx) * nx + (b.vy - best.vy) * ny;
      if (vn < 0) { b.vx -= 1.6 * vn * nx; b.vy -= 1.6 * vn * ny; }
      b.vx *= 0.55; b.vy *= 0.55;
      best.noCatch = 8;
      this.touch(best);
      this.events.push({ e: 'deflect', id: best.id });
    }
  }

  // Returns the goal side (-1 / 1) if the ball's path from (x0,y0) to (x1,y1) crossed a goal line
  // between the posts while travelling into the net; 0 otherwise.
  crossedGoalLine(x0, y0, x1, y1) {
    for (const side of [-1, 1]) {
      const gx = side * CFG.goalX;
      const before = side * (x0 - gx), after = side * (x1 - gx);
      if (before < 0 && after >= 0) {            // was in front of the line, now on or behind it
        const t = before / (before - after);
        const yc = y0 + (y1 - y0) * t;
        if (Math.abs(yc) < CFG.postY) return side;
      }
    }
    return 0;
  }

  collideLooseBall(active) {
    const b = this.ball;
    for (const p of active) {
      if (collideCircles(p, b, 0.5) > 0) this.touch(p);
    }
    this.collideBallStatic();
  }

  // Ball against the cages, posts and field walls.
  collideBallStatic() {
    const b = this.ball;
    let hit = 0;
    for (const side of [-1, 1]) {
      const g = GOALS[side];
      for (const s of g.segs) hit = Math.max(hit, collideSegment(b, s, 0.4));
      for (const post of g.posts) hit = Math.max(hit, collideFixedCircle(b, post.x, post.y, CFG.postR, 0.5));
    }
    if (hit > 2.5 && this.tick - this.lastPostSound > 10) { this.lastPostSound = this.tick; this.events.push({ e: 'post' }); }

    if (b.x < -CFG.hw + b.r) { b.x = -CFG.hw + b.r; b.vx = -b.vx * 0.5; }
    if (b.x > CFG.hw - b.r) { b.x = CFG.hw - b.r; b.vx = -b.vx * 0.5; }
    if (b.y < -CFG.hh + b.r) { b.y = -CFG.hh + b.r; b.vy = -b.vy * 0.5; }
    if (b.y > CFG.hh - b.r) { b.y = CFG.hh - b.r; b.vy = -b.vy * 0.5; }
  }

  constrainPlayer(p) {
    for (const side of [-1, 1]) {
      const g = GOALS[side];
      for (const s of g.segs) collideSegment(p, s, 0);
      collideSegment(p, g.mouthSeg, 0);
      for (const post of g.posts) collideFixedCircle(p, post.x, post.y, CFG.postR, 0);
      // only defenders may stand in their own crease
      if (side !== defSide(p.team)) pushOutOfCircle(p, g.crease.x, g.crease.y, CFG.creaseR + p.r);
    }

    if (this.phase === 'kickoff') {
      const own = defSide(p.team); // -1 = left half
      const onOppHalf = own < 0 ? p.x > 0 : p.x < 0;
      if (p.team !== this.kickoffTeam) {
        if (own < 0 ? p.x > -p.r : p.x < p.r) { p.x = own * p.r; p.vx = 0; }
        pushOutOfCircle(p, 0, 0, CFG.centerR + p.r);
      } else if (onOppHalf) {
        const R = CFG.centerR - p.r, d = Math.hypot(p.x, p.y);
        if (d > R) {
          if (Math.abs(p.y) < R) { p.x *= R / d; p.y *= R / d; }
          else p.x = 0;
          p.vx = 0;
        }
      }
    }

    if (p.x < -CFG.pmx + p.r) { p.x = -CFG.pmx + p.r; p.vx = 0; }
    if (p.x > CFG.pmx - p.r) { p.x = CFG.pmx - p.r; p.vx = 0; }
    if (p.y < -CFG.pmy + p.r) { p.y = -CFG.pmy + p.r; p.vy = 0; }
    if (p.y > CFG.pmy - p.r) { p.y = CFG.pmy - p.r; p.vy = 0; }
  }

  goalScored(side) {
    // side -1 is red's goal, so blue scores there
    const scoringTeam = side < 0 ? TEAM_BLUE : TEAM_RED;
    this.score[scoringTeam - 1]++;
    const b = this.ball;
    const scorer = this.players.get(b.lastTouch);
    const prev = this.players.get(b.prevTouch);
    const own = !!(scorer && scorer.team !== scoringTeam);
    const assist = !own && prev && prev.team === scoringTeam && prev !== scorer ? prev : null;
    this.phase = 'goal';
    this.phaseTimer = 150;
    this.kickoffTeam = scoringTeam === TEAM_RED ? TEAM_BLUE : TEAM_RED;
    this.events.push({ e: 'goal', team: scoringTeam, scorer: scorer ? scorer.id : 0, assist: assist ? assist.id : 0, own });
    const teamName = scoringTeam === TEAM_RED ? 'Red' : 'Blue';
    let msg = `Goal for ${teamName}!`;
    if (scorer) msg += own ? ` (own goal by ${scorer.name})` : ` Scored by ${scorer.name}` + (assist ? `, assist ${assist.name}` : '');
    this.messages.push(msg + `  ${this.score[0]} - ${this.score[1]}`);
  }

  endGame() {
    this.phase = 'over';
    this.phaseTimer = 300;
    const w = this.score[0] > this.score[1] ? TEAM_RED : this.score[1] > this.score[0] ? TEAM_BLUE : 0;
    this.events.push({ e: 'over', winner: w });
    this.messages.push(w ? `${w === TEAM_RED ? 'Red' : 'Blue'} wins ${this.score[0]} - ${this.score[1]}!` : 'Game over — draw.');
  }

  // ---------- network views ----------
  snapshot() {
    const b = this.ball;
    const phaseCode = { kickoff: 0, play: 1, goal: 2, over: 3 }[this.phase];
    return {
      t: 's', k: this.tick, ph: phaseCode, sc: this.score, tm: Math.floor(this.time / CFG.tickRate),
      ot: this.overtime ? 1 : 0, pa: this.paused ? 1 : 0, ko: this.kickoffTeam,
      b: [r1(b.x), r1(b.y), b.carrier],
      p: this.activePlayers().map((p) => [p.id, r1(p.x), r1(p.y), r2(p.angle), Math.round(p.charge * 100), p.swing]),
      ev: this.events.length ? this.events : undefined,
    };
  }
  roster(adminId) {
    return {
      t: 'room', admin: adminId, state: this.state, settings: this.settings, score: this.score,
      players: [...this.players.values()].sort((a, b) => a.joinOrder - b.joinOrder)
        .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, team: p.team, bot: p.bot })),
    };
  }
}

module.exports = { Game, CFG, PHYS, GOALS, defSide, TEAM_SPEC, TEAM_RED, TEAM_BLUE };
