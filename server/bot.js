'use strict';
// Simple computer players so you can play alone or fill out teams.
// Bots press the same buttons a human does (movement bits, throw, check) and aim like a mouse-aim player.

const { CFG, PHYS, GOALS, defSide } = require('./constants');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}
// distance from point p to segment a-b, plus how far along it lies (0..1)
function segDist(p, a, b) {
  const sx = b.x - a.x, sy = b.y - a.y, l2 = sx * sx + sy * sy || 1;
  const t = clamp(((p.x - a.x) * sx + (p.y - a.y) * sy) / l2, 0, 1);
  return { d: Math.hypot(p.x - (a.x + sx * t), p.y - (a.y + sy * t)), t };
}
function laneClear(from, to, blockers, margin) {
  for (const o of blockers) {
    const { d, t } = segDist(o, from, to);
    if (t > 0.05 && t < 0.98 && d < CFG.playerR + margin) return false;
  }
  return true;
}
// speed needed so a throw still has ~arrive speed when it travels `d` units
function chargeForDistance(d, arrive) {
  const v0 = d * (1 - PHYS.bDamp) + arrive;
  return clamp((v0 - PHYS.throwMin) / (PHYS.throwMax - PHYS.throwMin), 0.02, 1);
}

function botThink(g, p, active) {
  const b = g.ball;
  const mySide = defSide(p.team), oppSide = -mySide;
  const myGoal = GOALS[mySide], oppGoal = GOALS[oppSide];
  const myMouth = { x: myGoal.mouthX, y: 0 }, oppMouth = { x: oppGoal.mouthX, y: 0 };
  const mates = active.filter((q) => q.team === p.team);
  const opps = active.filter((q) => q.team !== p.team);
  const carrier = b.carrier ? g.players.get(b.carrier) : null;
  const S = p.botState || (p.botState = { has: false, plan: null, shotY: 0, hold: 0, wobble: Math.random() * 6 });

  let target = { x: p.x, y: p.y };
  let aim = null;
  let throwDown = false, check = false;

  const ballPt = { x: b.x, y: b.y };
  const pocketOf = (q) => ({ x: q.x + Math.cos(q.angle) * CFG.pocketDist, y: q.y + Math.sin(q.angle) * CFG.pocketDist });

  // Who on my team goes for the ball, and who minds the net?
  const sorted = [...mates].sort((a, c) => dist(a, ballPt) - dist(c, ballPt));
  const chaser = sorted[0];
  let goalie = null;
  if (mates.length >= 2) {
    goalie = mates.filter((q) => q !== chaser).sort((a, c) => dist(a, myMouth) - dist(c, myMouth))[0];
  }

  if (carrier === p) {
    // ---------------- I have the ball ----------------
    if (!S.has) {
      S.has = true; S.plan = null; S.hold = 0;
      S.shotY = (Math.random() * 2 - 1) * (CFG.postY - 12);
    }
    S.hold++;
    const dGoal = dist(p, oppMouth);
    const inFront = oppSide > 0 ? p.x < oppMouth.x - 20 : p.x > oppMouth.x + 20;
    const nearestOpp = opps.reduce((m, o) => (dist(o, p) < m.d ? { o, d: dist(o, p) } : m), { o: null, d: Infinity });

    if (S.plan) {
      // keep aiming and charging until the planned power is reached
      let tp = S.plan.to;
      if (S.plan.mate) {
        const m = S.plan.mate;
        const lead = dist(p, m) / 9;
        tp = { x: m.x + m.vx * lead, y: m.y + m.vy * lead };
      }
      aim = angTo(p, tp);
      target = { x: p.x + Math.cos(aim) * 20, y: p.y + Math.sin(aim) * 20 };
      throwDown = !(p.charge >= S.plan.c && angDiff(p.angle, aim) < 0.12);
      if (S.plan.mate && !laneClear(p, tp, opps, 4) && p.charge < 0.3) { S.plan = null; throwDown = false; }
    } else {
      // pick a shooting spot on the side away from the goalie
      const keeper = opps.find((o) => dist(o, oppMouth) < CFG.creaseR + 10);
      if (keeper) S.shotY = (keeper.y > 0 ? -1 : 1) * (CFG.postY - 9);
      const shotPt = { x: oppMouth.x, y: S.shotY };

      if (S.hold > 480) {
        // been holding too long (probably boxed in): just let it fly toward the goal area
        S.plan = { to: { x: oppMouth.x - oppSide * 60, y: 0 }, c: 0.7 };
        throwDown = true;
        aim = angTo(p, S.plan.to);
      } else if (inFront && (dGoal < 175 || (dGoal < 270 && laneClear(p, shotPt, opps.filter((o) => o !== keeper), 2)) || S.hold > 420)) {
        S.plan = { to: shotPt, c: clamp(0.72 + (dGoal - 90) / 500, 0.75, 1) };
        throwDown = true;
        aim = angTo(p, shotPt);
      } else if (nearestOpp.d < 60 && S.hold > 25) {
        // under pressure: look for an open teammate
        let best = null, bestScore = -Infinity;
        for (const m of mates) {
          if (m === p) continue;
          const d = dist(p, m);
          if (d < 70 || d > 480) continue;
          const openness = Math.min(...opps.map((o) => dist(o, m)), 200);
          if (openness < 45 || !laneClear(p, m, opps, 6)) continue;
          const score = openness - dist(m, oppMouth) * 0.5;
          if (score > bestScore) { bestScore = score; best = m; }
        }
        if (best) {
          S.plan = { mate: best, c: chargeForDistance(dist(p, best), 4.5) };
          throwDown = true;
          aim = angTo(p, best);
        }
      }

      if (!S.plan) {
        // run toward a spot in front of the goal, steering around defenders
        const tx = oppMouth.x - oppSide * 150;
        const ty = clamp(S.shotY * 3.2 + Math.sin(S.hold / 40 + S.wobble) * 40, -150, 150);
        let vx = tx - p.x, vy = ty - p.y;
        const l = Math.hypot(vx, vy) || 1; vx /= l; vy /= l;
        for (const o of opps) {
          const d = dist(o, p);
          if (d < 110) { vx += ((p.x - o.x) / d) * (110 - d) / 70; vy += ((p.y - o.y) / d) * (110 - d) / 70; }
        }
        target = { x: p.x + vx * 50, y: p.y + vy * 50 };
        // carry the ball on the side away from the nearest defender
        aim = Math.atan2(vy, vx);
        if (nearestOpp.o && nearestOpp.d < 70) {
          const away = angTo(nearestOpp.o, p);
          aim = angDiff(aim, away) < 1.6 ? away : aim;
        }
      }
    }
  } else {
    S.has = false; S.plan = null;

    if (!carrier) {
      // ---------------- loose ball ----------------
      if (p === chaser || (p !== goalie && dist(p, ballPt) < 90)) {
        const lead = clamp(dist(p, ballPt) / 6, 0, 25);
        const pred = { x: b.x + b.vx * lead, y: b.y + b.vy * lead };
        aim = angTo(p, pred);
        target = { x: pred.x - Math.cos(aim) * CFG.pocketDist * 0.8, y: pred.y - Math.sin(aim) * CFG.pocketDist * 0.8 };
      } else if (p === goalie) {
        ({ target, aim } = guardNet(myMouth, mySide, ballPt, p));
      } else {
        const idx = mates.indexOf(p);
        target = { x: (b.x + myMouth.x) / 2, y: clamp(b.y + (idx % 2 ? 110 : -110), -230, 230) };
        aim = angTo(p, ballPt);
      }
    } else if (carrier.team !== p.team) {
      // ---------------- defending ----------------
      if (p === goalie) {
        ({ target, aim } = guardNet(myMouth, mySide, ballPt, p));
      } else if (p === chaser || dist(p, carrier) < 80) {
        const toGoal = angTo(carrier, myMouth);
        target = { x: carrier.x + Math.cos(toGoal) * 26, y: carrier.y + Math.sin(toGoal) * 26 };
        aim = angTo(p, ballPt);
        const head = pocketOf(p);
        if (dist(head, ballPt) < 30 && p.checkCd === 0 && carrier.protect === 0 && Math.random() < 0.07) check = true;
      } else {
        // mark the nearest attacker who isn't carrying
        const marks = opps.filter((o) => o !== carrier).sort((a, c) => dist(a, p) - dist(c, p));
        const m = marks[0] || carrier;
        const toGoal = angTo(m, myMouth);
        target = { x: m.x + Math.cos(toGoal) * 45, y: m.y + Math.sin(toGoal) * 45 };
        aim = angTo(p, ballPt);
      }
    } else {
      // ---------------- teammate has it: get open ----------------
      if (p === goalie && mates.length >= 3) {
        ({ target, aim } = guardNet(myMouth, mySide, ballPt, p));
        target.x -= mySide * 120;
      } else {
        const others = mates.filter((q) => q !== carrier && !(q === goalie && mates.length >= 3));
        const idx = Math.max(0, others.indexOf(p));
        const spots = [[-150, -115], [-150, 115], [-250, 0], [60, -85], [60, 85]];
        const s = spots[idx % spots.length];
        target = { x: oppMouth.x + oppSide * s[0], y: s[1] + Math.sin(g.tick / 50 + S.wobble) * 25 };
        aim = angTo(p, carrier);
      }
    }
  }

  if (carrier === p) {
    // don't run over the field lines with the ball (that's a turnover)
    target.x = clamp(target.x, -CFG.hw + 28, CFG.hw - 28);
    target.y = clamp(target.y, -CFG.hh + 28, CFG.hh - 28);
  }
  setInput(p, target, aim, throwDown, check);
}

function guardNet(mouth, side, ballNow, p) {
  // stand in the crease between the ball and the goal mouth, facing the ball.
  // The goalie tracks a lagged copy of the ball so quick passes and corner shots can beat it.
  const S = p.botState;
  if (!S.seen) S.seen = { x: ballNow.x, y: ballNow.y };
  S.seen.x += (ballNow.x - S.seen.x) * 0.1;
  S.seen.y += (ballNow.y - S.seen.y) * 0.1;
  const ball = S.seen;
  const fwd = side < 0 ? 0 : Math.PI;
  let a = Math.atan2(ball.y - mouth.y, ball.x - mouth.x);
  let d = a - fwd;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  d = clamp(d, -1.25, 1.25);
  a = fwd + d;
  const r = CFG.playerR + 13;
  return { target: { x: mouth.x + Math.cos(a) * r, y: mouth.y + Math.sin(a) * r }, aim: angTo(p, ballNow) };
}

function setInput(p, target, aim, throwDown, check) {
  // look ahead so bots brake instead of overshooting
  const dx = target.x - (p.x + p.vx * 10), dy = target.y - (p.y + p.vy * 10);
  const d = Math.hypot(dx, dy);
  let bits = 0;
  if (d > 4) {
    if (dx > 0.38 * d) bits |= 8;
    if (dx < -0.38 * d) bits |= 4;
    if (dy > 0.38 * d) bits |= 2;
    if (dy < -0.38 * d) bits |= 1;
  }
  if (throwDown) bits |= 16;
  if (check) bits |= 32;
  p.input = bits;
  p.aimMode = true;
  p.aim = aim !== null && aim !== undefined ? aim : (d > 4 ? Math.atan2(dy, dx) : p.angle);
}

module.exports = { botThink };
