// How the hub says a player got from one point of a trail to the next (D-103),
// after classifyStep in its packages/core/src/trail.ts as of its commit
// d784c93. It is in a file of its own so that the map's tests can hold it
// against the hub's own cases (site/test/mock-hub.test.js); server.js is
// still all there is to run.

const TICK_MS = 600;
const MINUTE_MS = 60_000;
// Two points further apart in time than this say nothing about what happened in between.
const GAP_MS = 5 * MINUTE_MS;
// Running covers two tiles a game tick; a boat is taken to go twice as fast.
const RUN_TILES_PER_TICK = 2;
const BOAT_TILES_PER_TICK = 4;
// After lag the position catches up several tiles at once.
const SLACK_TILES = 6;
// The underground is the surface, this many tiles further north.
const UNDERGROUND_OFFSET_Y = 6400;
// Where the rooms of a player-owned house are: the plugin reports the tile of
// the map area each room was copied from.
const HOUSE_AREA = { minX: 1852, maxX: 2115, minY: 7036, maxY: 7116 };
// Other instances the game builds from copied rooms, by map region (64 by 64
// tiles; see regionId).
const INSTANCE_REGIONS = {
  gauntlet: [7512],
  corruptedGauntlet: [7768],
  chambersOfXeric: [12889, 13136, 13137, 13138, 13139, 13140, 13141, 13145, 13393, 13394, 13395, 13396, 13397, 13401],
};
const INSTANCE_OF_REGION = new Map(
  Object.entries(INSTANCE_REGIONS).flatMap(([name, regions]) => regions.map((id) => [id, name]))
);

const inHouse = (p) => p.x >= HOUSE_AREA.minX && p.x <= HOUSE_AREA.maxX && p.y >= HOUSE_AREA.minY && p.y <= HOUSE_AREA.maxY;

// The map region a tile is in, as the game numbers them.
const regionId = (p) => ((p.x >> 6) << 8) | (p.y >> 6);

function inOneInstance(a, b) {
  const instance = INSTANCE_OF_REGION.get(regionId(a));
  return instance !== undefined && instance === INSTANCE_OF_REGION.get(regionId(b));
}

// The step from `prev` to `next`, two consecutive points of one trail:
// `{t, x, y, boat}` with `t` in ms since the epoch.
//
// A point is the tick on which the tile changed, so the step to it took one
// tick, however long the player stood on the point before: 8 tiles of reach,
// 10 while both points are on a boat. Only a sample on the whole minute (a
// plugin from before 1.6, or a player standing still) is judged by the time
// since the point before.
function trailStep(prev, next) {
  const elapsed = next.t - prev.t;
  if (elapsed > GAP_MS) return "gap";
  const minuteSample = next.t % MINUTE_MS === 0;
  const ticks = minuteSample ? Math.max(1, Math.ceil(elapsed / TICK_MS)) : 1;
  const speed = prev.boat && next.boat ? BOAT_TILES_PER_TICK : RUN_TILES_PER_TICK;
  const reach = ticks * speed + SLACK_TILES;
  // Diagonal steps cost the same as straight ones.
  const far = (shiftY) => Math.max(Math.abs(next.x - prev.x), Math.abs(next.y - prev.y - shiftY));
  if (far(0) <= reach) return "move";
  if (inHouse(prev) && inHouse(next)) return "house";
  if (inOneInstance(prev, next)) return "instance";
  if (far(UNDERGROUND_OFFSET_Y) <= reach || far(-UNDERGROUND_OFFSET_Y) <= reach) return "entrance";
  return "teleport";
}

module.exports = { trailStep };
