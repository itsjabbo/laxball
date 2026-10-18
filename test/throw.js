// Verify throw speed scales with how long Space is held.
const { Game } = require('../server/game');
for (const hold of [1, 15, 33, 50, 66, 120]) {
  const g = new Game(); g.settings.timeLimit = 0;
  const p = g.addPlayer('T', 'T'); g.setTeam(p.id, 1); g.start();
  g.phase = 'play'; g.ball.carrier = p.id; p.angle = 0; p.protect = 0;
  p.input = 16; for (let i = 0; i < hold; i++) g.step();
  p.input = 0; g.step();
  const sp = Math.hypot(g.ball.vx, g.ball.vy);
  let x0 = g.ball.x; for (let i = 0; i < 400 && !g.ball.carrier; i++) { p.x = -500; p.y = 250; g.step(); }
  console.log(`hold ${String(hold).padStart(3)} ticks (${(hold/60).toFixed(2)}s) -> speed ${sp.toFixed(2)}/tick = ${(sp*60).toFixed(0)} units/s`);
}
