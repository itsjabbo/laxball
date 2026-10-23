// Fires the ball at both cages from behind and from the front at many angles/speeds.
// Shots from behind must never count; clean shots from the front must.
const { Game } = require('../server/game');
const { CFG } = require('../server/constants');
function shoot(side, fromBehind, angDeg, speed, yOff) {
  const g = new Game(); g.settings.timeLimit = 0;
  const p = g.addPlayer('T', 'T'); g.setTeam(p.id, side > 0 ? 1 : 2); g.start();
  p.x = 0; p.y = -250; // keep the player out of the way
  g.phase = 'play';
  const b = g.ball; b.carrier = 0;
  const a = angDeg * Math.PI / 180;
  if (fromBehind) { b.x = side * (CFG.goalX + CFG.goalDepth + 30); b.y = yOff; b.vx = -side * Math.cos(a) * speed; b.vy = Math.sin(a) * speed; }
  else { b.x = side * (CFG.goalX - 60); b.y = yOff; b.vx = side * Math.cos(a) * speed; b.vy = Math.sin(a) * speed; }
  for (let t = 0; t < 90; t++) { g.step(); if (g.events.some((e) => e.e === 'goal')) return true; p.x = 0; p.y = -250; }
  return false;
}
let behindGoals = 0, behindTotal = 0, frontGoals = 0, frontTotal = 0;
for (const side of [-1, 1])
  for (let ang = -60; ang <= 60; ang += 5)
    for (const speed of [3, 6, 9, 12, 13.5, 16])
      for (const yOff of [-30, -15, 0, 15, 30]) {
        behindTotal++; if (shoot(side, true, ang, speed, yOff)) behindGoals++;
        if (Math.abs(ang) <= 15 && Math.abs(yOff) <= 15) { frontTotal++; if (shoot(side, false, ang, speed, yOff)) frontGoals++; }
      }
console.log(`from behind: ${behindGoals}/${behindTotal} counted as goals (want 0)`);
console.log(`from front:  ${frontGoals}/${frontTotal} counted as goals (want all)`);
process.exitCode = behindGoals === 0 && frontGoals === frontTotal ? 0 : 1;
