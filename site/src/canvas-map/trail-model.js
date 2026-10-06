import { GuildData } from "../data/guild-data";
import { eventKind, eventPlace, eventTier, eventTimeMs } from "../data/event-view";
import { clockTime, shortDay } from "../data/format";

// What a player's trail is, apart from how it is drawn: the points the hub
// has (every tile a player was on, and one a minute while they stand still)
// joined with the positions seen live, and what happened between each two of
// them. Everything here is in the site's coordinates (one tile north of what
// the plugin reports) and unix seconds.
//
// A point is `{x, y, plane, t0, t1, boat, world, via?, live?}`: the player was
// on the tile from t0 to t1. `via` is how the hub says they got there from the
// point before (move, entrance, house, instance, teleport or gap; hub D-103),
// or "other" for a label that the server or this site doesn't know.
// The step from one point to the next is one of:
//   walk      on foot
//   stairs    the same, to another floor
//   sail      both ends on a boat
//   entrance  into or out of the underground, which the game puts 6400 tiles north
//   house     into the next room of a player-owned house: walked, but the
//             rooms lie apart on the map
//   instance  the same between two rooms of a raid (the Gauntlet, the
//             Chambers of Xeric), which the game also builds from copied rooms
//   teleport  anything else that wasn't walked
//   unknown   a gap in the data, or a label nobody knows: not walked, and
//             nothing more is known about it
// The hub's label decides. A point without one (seen live between two polls,
// or from a hub that doesn't say) is judged by distance and time, where
// teleport is "further than anyone could have run, or to another part of the
// map" and unknown also "far enough that it may have been either". A label
// that isn't known is never judged that way: the hub's API says to take such
// a step for not walked, and a guess could draw it as a line.

const TICK_S = 0.6;

// Running covers two tiles a game tick.
const RUN_TILES_PER_S = 2 / TICK_S;

// A guess: nothing says how fast a boat goes or what the plugin reports on one.
const BOAT_TILES_PER_S = 2 * RUN_TILES_PER_S;

// A player standing still keeps one point a minute, so the points of a trail
// that wasn't thinned are never further apart than this without a gap.
const IDLE_S = 60;

// For points without a label. A hub that doesn't label dates a sample at the
// start of its minute, so more time may have passed than two samples say.
// Allowing the full minute would hide most teleports.
const UNCERTAINTY_S = 20;

const SLACK_TILES = 8;

// Up to this share of the distance a run could cover, it was a run for sure.
const SURE_FRACTION = 0.75;

// Samples further apart than this are a gap: logged out, or not sharing.
const GAP_S = 300;
const UNDERGROUND_OFFSET = 6400;
const FLAG_BOAT = 1;
const LIVE_MAX_POINTS = 240;
const LIVE_MAX_AGE_S = 3600;
// How far a marker is behind the hub at most: the backend asks the hub every
// 5 s and the site the backend every 2 s. The rest is for a plugin's clock,
// which dates the hub's points, being behind the server's.
const MARKER_LAG_S = 15;
// The server's codes for the hub's labels (`via_code` in its trails.rs): 0 is
// "the hub didn't say", 7 a label of the hub's that the server doesn't know.
const VIA = [undefined, "move", "entrance", "house", "teleport", "gap", "instance", "other"];
// A code this site doesn't know is a label it doesn't know.
const VIA_NOT_KNOWN = "other";

/**
 * Reads a trail as the server sends it: `{step, as_of, points, worlds}` with
 * points `[x, y, plane, unixSeconds, dwell, flags, via]` (see the server's
 * `trail_json`), or the bare list of `[x, y, plane, unixSeconds]` an older
 * server sends. `asOf` is when the hub gave the trail, where the server says.
 */
export function decodeTrail(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.points || [];
  const worlds = (!Array.isArray(raw) && raw?.worlds) || [];
  const points = [];
  let world = null;
  let nextWorld = 0;
  rows.forEach(([x, y, plane, time, dwell = 0, flags = 0, via = 0], index) => {
    while (nextWorld < worlds.length && worlds[nextWorld][0] <= index) {
      world = worlds[nextWorld][1];
      nextWorld += 1;
    }
    const coordinates = GuildData.transformCoordinatesFromStorage([x, y, plane]);
    if (
      [coordinates.x, coordinates.y, coordinates.plane, time].some((value) => typeof value !== "number" || isNaN(value))
    ) {
      return;
    }
    const point = { ...coordinates, t0: time - dwell, t1: time, boat: Boolean(flags & FLAG_BOAT), world };
    if (via) point.via = VIA[via] ?? VIA_NOT_KNOWN;
    points.push(point);
  });
  return { points, step: (!Array.isArray(raw) && raw?.step) || IDLE_S, asOf: raw?.as_of ?? undefined };
}

/**
 * The part of the map a tile is in. Each has its own coordinate range, so
 * going from one to another is never a walk across the map.
 */
export function band(x, y) {
  const storedY = y - 1;
  if (x >= 6400) return "instance";
  if (storedY < 4224) return "surface";
  if (storedY >= 8448 && storedY < 10624) return "under";
  return "other";
}

function distance(a, b, shiftY = 0) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - (b.y + shiftY)));
}

/** A step the hub calls a move: which kind of moving it was. */
function moveKind(a, b) {
  if (a.boat && b.boat) return "sail";
  return a.plane !== b.plane ? "stairs" : "walk";
}

/**
 * What happened between two consecutive points; see the top of this file.
 * `gapS` is how far apart two points without a label may be before it is a
 * gap in the data.
 */
export function classifyStep(a, b, gapS = GAP_S) {
  switch (b.via) {
    case "move":
      return moveKind(a, b);
    case "entrance":
    case "house":
    case "instance":
    case "teleport":
      return b.via;
    case "gap":
    case "other":
      return "unknown";
  }
  const elapsed = Math.max(b.t0 - a.t1, 1);
  const speed = a.boat && b.boat ? BOAT_TILES_PER_S : RUN_TILES_PER_S;
  const sure = SURE_FRACTION * speed * elapsed + SLACK_TILES;
  const bandA = band(a.x, a.y);
  const bandB = band(b.x, b.y);
  if (bandA !== bandB) {
    if (bandA !== "instance" && bandB !== "instance" && (bandA === "under" || bandB === "under")) {
      const shift = bandB === "under" ? -UNDERGROUND_OFFSET : UNDERGROUND_OFFSET;
      if ((bandA === "surface" || bandB === "surface") && distance(a, b, shift) <= sure) return "entrance";
    }
    return "teleport";
  }
  const far = distance(a, b);
  if (far > speed * (elapsed + UNCERTAINTY_S) + SLACK_TILES) return "teleport";
  if (elapsed > gapS || far > sure) return "unknown";
  return moveKind(a, b);
}

const CONNECTED = new Set(["walk", "stairs", "sail"]);

/**
 * Whether a step is a walk into the next room of something the game builds
 * from copied rooms, a player-owned house or a raid. The player walked, but
 * the two ends lie apart on the map: there is no line to draw between them,
 * nothing for a replay to stop for and nothing to mark on its timeline.
 */
export function isNextRoom(kind) {
  return kind === "house" || kind === "instance";
}

/**
 * Classifies every step of a trail. `runs` are the stretches drawn as one
 * line (`{i0, i1, sail}`, point indices; a boat trip is its own run and
 * shares its end points with the walks around it; a run may be one point),
 * `jumps` the steps between runs (`{from, kind}`, from point `from` to the
 * next). `step` is the longest time the server left between two points with
 * no break between them, so that the wider spacing of a thinned trail isn't
 * taken for gaps where the hub didn't label it.
 */
export function buildTrailModel(points, { step = IDLE_S } = {}) {
  const gapS = Math.max(GAP_S, step);
  const kinds = [];
  for (let i = 0; i + 1 < points.length; i++) {
    kinds.push(classifyStep(points[i], points[i + 1], gapS));
  }
  const runs = [];
  const jumps = [];
  let start = 0;
  for (let i = 0; i < points.length; i++) {
    const kind = kinds[i];
    if (i === points.length - 1 || !CONNECTED.has(kind)) {
      if (i === start || kinds[start] === undefined) {
        runs.push({ i0: start, i1: i, sail: false });
      } else {
        // Split the chain wherever sailing starts or stops.
        let from = start;
        for (let j = start + 1; j <= i; j++) {
          if (j === i || (kinds[j] === "sail") !== (kinds[from] === "sail")) {
            runs.push({ i0: from, i1: j, sail: kinds[from] === "sail" });
            from = j;
          }
        }
      }
      if (i < points.length - 1) jumps.push({ from: i, kind });
      start = i + 1;
    }
  }
  return {
    points,
    kinds,
    runs,
    jumps,
    gapS,
    tMin: points.length ? points[0].t0 : null,
    tMax: points.length ? points[points.length - 1].t1 : null,
  };
}

function sameTile(a, b) {
  return a.x === b.x && a.y === b.y && a.plane === b.plane;
}

/**
 * Notes where a player is now in their buffer of live points. Returns whether
 * that added a point: they moved to another tile, or (`fresh`) they are back
 * from having been away, which starts a new stay even on the same tile.
 */
export function observeLive(
  buffer,
  coordinates,
  nowS,
  { maxPoints = LIVE_MAX_POINTS, maxAgeS = LIVE_MAX_AGE_S, fresh = false } = {},
) {
  const last = buffer[buffer.length - 1];
  let moved = false;
  if (!fresh && last && sameTile(last, coordinates) && last.boat === Boolean(coordinates.boat)) {
    last.t1 = Math.max(last.t1, nowS);
  } else {
    const time = last ? Math.max(nowS, last.t1) : nowS;
    buffer.push({
      x: coordinates.x,
      y: coordinates.y,
      plane: coordinates.plane,
      boat: Boolean(coordinates.boat),
      world: coordinates.world ?? null,
      t0: time,
      t1: time,
      live: true,
    });
    moved = true;
  }
  let drop = Math.max(0, buffer.length - maxPoints);
  while (drop < buffer.length - 1 && buffer[drop].t1 < nowS - maxAgeS) drop += 1;
  if (drop) buffer.splice(0, drop);
  return moved;
}

/**
 * The hub's history followed by what was seen live since. `asOf` is when the
 * hub gave that history, by the clock the live points are dated with. A
 * marker shows where the hub had the player a few seconds before, so what
 * the site saw before then the history has too, tile by tile: only a live
 * point from then on is added. When the marker got there counts, not how
 * long it stayed: it stands still between two of the plugin's messages
 * wherever the player goes, and the hub's own times are the plugin's clock.
 * `head` (`{x, y, plane, boat, world, t}`, where the marker is while the
 * player is online) is the last point, so the trail ends on the marker. Only
 * a marker that is itself behind the history is left out: the hub has the
 * player further on, and the marker follows within seconds.
 *
 * `from` is when the span of the trail began, when it was asked for from a
 * moment (a play session that still goes on) and not in days. What was seen
 * before then is no part of it, also when the hub has no point in the span:
 * the live points go back as far as the tab has been open. A sighting that
 * lasted into the span begins where the span does.
 */
export function mergeTrail(history, live, head, asOf, from = null) {
  const merged = history.slice();
  const newest = history[history.length - 1];
  const samePlace = (a, b) => sameTile(a, b) && a.boat === b.boat;
  // Two visits to a tile with an absence in between stay two points; the
  // marker of an online player continues the stay however long it has lasted.
  const append = (point, continues = point.t0 - merged[merged.length - 1]?.t1 <= GAP_S) => {
    const last = merged[merged.length - 1];
    if (last && continues && samePlace(last, point)) {
      merged[merged.length - 1] = { ...last, t1: Math.max(last.t1, point.t1) };
    } else {
      const t0 = last ? Math.max(point.t0, last.t1) : point.t0;
      merged.push({ ...point, t0, t1: Math.max(point.t1, t0) });
    }
  };
  const isNews = (point) => !newest || point.t0 >= asOf;
  for (const seen of live) {
    if (from !== null && seen.t1 < from) continue;
    const point = from !== null && seen.t0 < from ? { ...seen, t0: from } : seen;
    if (isNews(point)) append(point);
  }
  if (head) {
    const { t, ...position } = head;
    const marker = { world: null, ...position, boat: Boolean(head.boat), t0: t, t1: t, live: true };
    const arrived = live[live.length - 1];
    // A history without every tile (a plugin that sends none, so a point a
    // minute) can miss where the marker is: its newest point is older then.
    const behind =
      arrived &&
      samePlace(arrived, marker) &&
      !isNews(arrived) &&
      !samePlace(newest, marker) &&
      newest.t1 >= arrived.t0 - MARKER_LAG_S;
    if (!behind) append(marker, true);
  }
  return merged;
}

/** The index of the last point reached by time t, or -1. */
function indexAt(points, t) {
  let low = 0;
  let high = points.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (points[middle].t0 <= t) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Where the player was at time t: `{index, frac, kind, x, y, plane, moving}`.
 * On a tile `frac` is 0; under way it is how far the step from point `index`
 * to the next has got (0..1) and `kind` what that step is. The position is
 * interpolated on steps that are drawn as a line and stays at the start of a
 * jump. Null before the trail starts.
 */
export function positionAt(model, t) {
  const { points, kinds } = model;
  const index = indexAt(points, t);
  if (index < 0) return null;
  const point = points[index];
  const next = points[index + 1];
  if (!next || t <= point.t1) {
    return { index, frac: 0, kind: null, x: point.x, y: point.y, plane: point.plane, moving: false };
  }
  const frac = (t - point.t1) / Math.max(next.t0 - point.t1, 1e-9);
  const kind = kinds[index];
  const along = CONNECTED.has(kind) ? frac : 0;
  return {
    index,
    frac,
    kind,
    x: point.x + (next.x - point.x) * along,
    y: point.y + (next.y - point.y) * along,
    plane: along < 1 ? point.plane : next.plane,
    moving: true,
  };
}

/**
 * When something next happens on the trail at or after t: t itself while the
 * player is under way, the end of the stay or of the absence while
 * nothing is happening, null after the last point.
 */
export function nextChangeAfter(model, t) {
  const { points, kinds, gapS } = model;
  if (!points.length) return null;
  const index = indexAt(points, t);
  if (index < 0) return points[0].t0;
  const next = points[index + 1];
  if (!next) return null;
  if (t <= points[index].t1) return points[index].t1;
  // Nothing happens before a jump lands, however long that takes. A thinned
  // trail can have hours between two points of one walk, so the time alone
  // doesn't tell a logout from a quiet stretch; the kind of step does.
  if (!CONNECTED.has(kinds[index]) || next.t0 - points[index].t1 > gapS) return next.t0;
  return t;
}

// An event may fall this long before or after a trail and still be marked on it.
const MARK_SLACK_S = 60;

/**
 * A member's hub events as marks on their trail:
 * `[{id, event, x, y, plane, t, approximate}]`, oldest first. An event that
 * says where it happened is marked there; any other where the trail has the
 * player at that time, which is a guess (`approximate`) when they were
 * between two places the trail can't join up. Events of a type the map
 * doesn't show, and those from outside the time the trail covers, are left
 * out.
 */
export function placeMarks(events, member, model) {
  const marks = [];
  if (model.tMin === null) return marks;
  for (const event of events) {
    if (event.member !== member || !event.id || !eventKind(event)) continue;
    const time = eventTimeMs(event);
    if (time === null) continue;
    const t = time / 1000;
    if (t < model.tMin - MARK_SLACK_S || t > model.tMax + MARK_SLACK_S) continue;
    let place = eventPlace(event);
    let approximate = false;
    if (!place) {
      place = positionAt(model, t);
      if (!place) continue;
      approximate = place.moving && !CONNECTED.has(place.kind);
    }
    if (isNaN(place.x) || isNaN(place.y)) continue;
    marks.push({ id: event.id, event, x: place.x, y: place.y, plane: place.plane, t, approximate });
  }
  return marks.sort((a, b) => a.t - b.t);
}

/**
 * The moments worth a tick on the replay timeline, oldest first: teleports
 * as `{t, kind: "teleport"}` and the events marked on the trail (see
 * placeMarks) as `{t, kind, tier}`, with the event's kind and how notable
 * it is.
 */
export function timelineTicks(model, marks = []) {
  const ticks = model.jumps
    .filter((jump) => jump.kind === "teleport")
    .map((jump) => ({ t: model.points[jump.from + 1].t0, kind: "teleport" }));
  for (const mark of marks) ticks.push({ t: mark.t, kind: eventKind(mark.event), tier: eventTier(mark.event) });
  return ticks.sort((a, b) => a.t - b.t);
}

/** "14:32", or "14:10 – 14:32" for a stay; with the day when it wasn't today. */
export function formatTrailTime(t0, t1, nowS = Date.now() / 1000) {
  const today = new Date(nowS * 1000).toDateString();
  const format = (t, withDay) => {
    const date = new Date(t * 1000);
    if (!withDay || date.toDateString() === today) return clockTime(date);
    return `${shortDay(date)} ${clockTime(date)}`;
  };
  if (t1 - t0 < IDLE_S) return format(t1, true);
  const sameDay = new Date(t0 * 1000).toDateString() === new Date(t1 * 1000).toDateString();
  return `${format(t0, true)} – ${format(t1, !sameDay)}`;
}
