// Headless bot-vs-bot match to sanity check the simulation.
const { Game } = require('../server/game');
const n = parseInt(process.argv[2] || '2', 10);
const minutes = parseFloat(process.argv[3] || '3');
const g = new Game();
g.settings.scoreLimit = 0; g.settings.timeLimit = 0;
for (let i = 0; i < n; i++) { g.addBot(1); g.addBot(2); }
g.start();
const counts = {};
let carryTicks = 0, nan = false;
const ticks = minutes * 60 * 60;
for (let t = 0; t < ticks; t++) {
  g.step();
  for (const e of g.events) counts[e.e] = (counts[e.e] || 0) + 1;
  if (g.ball.carrier) carryTicks++;
  for (const p of g.players.values()) if (!isFinite(p.x + p.y + p.vx + p.angle)) nan = true;
  if (!isFinite(g.ball.x + g.ball.y)) nan = true;
}
console.log(`${n}v${n}, ${minutes} min:`, JSON.stringify(counts), 'score', g.score, 'possession%', (100 * carryTicks / ticks).toFixed(0), 'NaN?', nan, 'phase', g.phase);
