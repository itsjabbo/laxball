'use strict';
// Shared tuning values and field geometry.

const CFG = {
  tickRate: 60,
  hw: 560, hh: 290,        // half-size of the field lines (the ball bounces off these)
  pmx: 600, pmy: 325,      // half-size of the area players may move in
  playerR: 15,
  ballR: 6,
  pocketDist: 31,          // distance from player centre to the middle of the stick head
  catchR: 12,              // how close the ball must be to the stick head to be caught
  goalX: 450,              // x of the goal mouth (mirrored for each side)
  postY: 42,               // half-width of the goal mouth
  goalDepth: 34,           // how far the cage extends behind the mouth
  postR: 4,
  creaseR: 64,             // radius of the crease circle (attackers can't enter)
  creaseOff: 10,           // crease centre sits a little behind the goal mouth
  centerR: 75,             // centre circle radius (kickoff restriction)
  restrainX: 330,          // restraining lines (decoration)
};

const PHYS = {
  accel: 0.12, accelCarry: 0.105, accelCharge: 0.075, accelSwing: 0.09,
  pDamp: 0.96,
  bDamp: 0.985,
  throwMin: 3.2,           // speed of a quick tap
  throwMax: 13.5,          // speed of a fully charged shot
  chargeTicks: 66,         // ~1.1 seconds of holding Space for full power
  catchMaxSpeed: 10.5,     // faster balls bounce off the stick instead of being caught
  checkTicks: 12, checkCd: 42, checkHitR: 18,
  catchProtect: 15,        // brief window after a catch where you can't be checked
  turnRate: 0.35,
  playerInvMass: 0.5, ballInvMass: 1,
};

const TEAM_SPEC = 0, TEAM_RED = 1, TEAM_BLUE = 2;
// Red defends the left goal (side -1), blue defends the right goal (side +1).
const defSide = (team) => (team === TEAM_RED ? -1 : 1);

const SPAWNS = [
  [-220, 0], [-300, -110], [-300, 110], [-420, 0],
  [-170, -175], [-170, 175], [-380, -60], [-380, 60],
];

function goalGeom(side) {
  const mx = side * CFG.goalX;
  const ax = side * (CFG.goalX + CFG.goalDepth);
  const top = { x: mx, y: -CFG.postY }, bot = { x: mx, y: CFG.postY }, apex = { x: ax, y: 0 };
  return {
    side, mouthX: mx, top, bot, apex,
    segs: [
      { x1: top.x, y1: top.y, x2: apex.x, y2: apex.y },
      { x1: bot.x, y1: bot.y, x2: apex.x, y2: apex.y },
    ],
    mouthSeg: { x1: top.x, y1: top.y, x2: bot.x, y2: bot.y },
    posts: [top, bot],
    crease: { x: side * (CFG.goalX + CFG.creaseOff), y: 0 },
  };
}
const GOALS = { '-1': goalGeom(-1), '1': goalGeom(1) };

module.exports = { CFG, PHYS, TEAM_SPEC, TEAM_RED, TEAM_BLUE, defSide, SPAWNS, GOALS };
