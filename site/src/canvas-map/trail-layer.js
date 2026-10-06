import {
  buildTrailModel,
  decodeTrail,
  mergeTrail,
  nextChangeAfter,
  observeLive,
  placeMarks,
  timelineTicks,
} from "./trail-model";
import { buildGeometry, hitTest, hopFocus, lodForZoom, placeAtTime } from "./trail-geometry";
import { drawTrail } from "./trail-renderer";

const DAY_S = 86400;

/**
 * The trails on the map: for each player shown, the hub's history joined with
 * where they have been seen since, and the shapes to draw it with. Positions
 * are noted for every player, shown or not, so a trail that is switched on
 * already knows where its player is.
 */
export class TrailLayer {
  /** `now` gives the time in unix seconds, by the clock the hub's samples use. */
  constructor({ now = () => Date.now() / 1000 } = {}) {
    this.now = now;
    this.trails = new Map();
    this.seen = new Map();
    this.events = new Map();
    this.eventFilter = null;
    this.eventFilterVersion = 0;
    this.replayTime = null;
    this.hop = null;
    this.hover = null;
  }

  /**
   * Shows (or refreshes) a player's trail from the server's answer; see
   * decodeTrail. `windowS` is how long a time the trail was asked for, and
   * `until` when that time ended (unix seconds) if it didn't run until now:
   * a play session that is over. Such a trail is what the hub has of it and
   * no more; where the player is now is no part of it.
   */
  setHistory(name, raw, { color, light, windowS = DAY_S, until = null }) {
    const { points, step } = decodeTrail(raw);
    this.trails.set(name, { history: points, step, color, light, windowS, until });
    this.rebuild(name);
  }

  remove(name) {
    if (this.hover?.name === name) this.hover = null;
    this.events.delete(name);
    return this.trails.delete(name);
  }

  clear() {
    this.hover = null;
    this.events.clear();
    this.trails.clear();
  }

  names() {
    return [...this.trails.keys()];
  }

  modelOf(name) {
    return this.trails.get(name)?.model || null;
  }

  isOnline(name) {
    return Boolean(this.seen.get(name)?.online);
  }

  /** Whether a player's trail is shown and runs until now. */
  endsNow(name) {
    const trail = this.trails.get(name);
    return Boolean(trail) && trail.until === null;
  }

  /**
   * Notes where a player is (`{x, y, plane, boat, world}` in the site's
   * coordinates, or null when that isn't known) and whether they are online.
   * Returns whether a trail on the map changed.
   */
  observe(name, position, online) {
    let seen = this.seen.get(name);
    if (!seen) {
      seen = { buffer: [], position: null, online: false };
      this.seen.set(name, seen);
    }
    const wasOnline = seen.online;
    seen.online = Boolean(online);
    let moved = false;
    if (position) {
      seen.position = position;
      // Coming back online starts a new stay: the time away isn't time spent there.
      if (seen.online) moved = observeLive(seen.buffer, position, this.now(), { fresh: !wasOnline });
    }
    // A trail that ended before now doesn't change with where they are.
    if (!this.endsNow(name)) return false;
    if (moved || wasOnline !== seen.online) {
      this.rebuild(name);
      return true;
    }
    return false;
  }

  /** The hub events of a player, to mark on their trail. */
  setEvents(name, events) {
    this.events.set(name, events);
    const trail = this.trails.get(name);
    if (trail) trail.marks = null;
  }

  /**
   * Which events count on the timeline and for what happens next:
   * `passes(event)`, as the map's filters have it. Null lets them all through.
   */
  setEventFilter(passes) {
    this.eventFilter = passes;
    this.eventFilterChanged();
  }

  /** The filter answers differently from now on: what was worked out with it is done again. */
  eventFilterChanged() {
    this.eventFilterVersion += 1;
  }

  /** The events on a player's trail, whatever the filter; see placeMarks. */
  marksOn(name) {
    const trail = this.trails.get(name);
    if (!trail) return [];
    if (!trail.marks) trail.marks = placeMarks(this.events.get(name) || [], name, trail.model);
    return trail.marks;
  }

  /** The events on a player's trail that the filter lets through, oldest first. */
  shownMarksOn(name) {
    const marks = this.marksOn(name);
    if (!this.eventFilter) return marks;
    const trail = this.trails.get(name);
    // Kept until the marks or the filter change: a replay asks every frame.
    if (trail.shownOf !== marks || trail.shownVersion !== this.eventFilterVersion) {
      trail.shown = marks.filter((mark) => this.eventFilter(mark.event));
      trail.shownOf = marks;
      trail.shownVersion = this.eventFilterVersion;
    }
    return trail.shown;
  }

  colorOf(name) {
    return this.trails.get(name)?.color || null;
  }

  rebuild(name) {
    const trail = this.trails.get(name);
    const seen = trail.until === null ? this.seen.get(name) : null;
    const head = seen?.online && seen.position ? { ...seen.position, t: this.now() } : null;
    const points = mergeTrail(trail.history, seen?.buffer || [], head);
    trail.model = buildTrailModel(points, { step: trail.step });
    trail.geometries = [];
    trail.marks = null;
    if (this.hover?.name === name) this.hover = null;
  }

  geometryOf(trail, lod) {
    if (!trail.geometries[lod]) trail.geometries[lod] = buildGeometry(trail.model, lod);
    return trail.geometries[lod];
  }

  /**
   * Shows the trails as they were at a time (unix seconds); null goes back to
   * live. `hop` is the teleport being played out meanwhile, if one is:
   * `{name, leave, land, progress}`, whose it is, when they left and landed,
   * and how far it has got (0..1).
   */
  setReplay(time, hop = null) {
    this.replayTime = time;
    this.hop = time === null ? null : hop;
  }

  /**
   * The teleport being played out on a player's trail, as their geometry has
   * it: `{jump, progress}`, or null when none is (or the trail has changed and
   * no longer has it).
   */
  hopOn(name, geometry) {
    const { hop } = this;
    if (!hop || hop.name !== name) return null;
    const jump = geometry.jumps.find((candidate) => candidate.tA === hop.leave && candidate.tB === hop.land);
    return jump ? { jump, progress: hop.progress } : null;
  }

  /**
   * The time span of the trails shown and what happened in it:
   * `{tMin, tMax, ticks: [{t, kind, color}]}`, for the replay timeline.
   */
  timeline() {
    let tMin = null;
    let tMax = null;
    const ticks = [];
    for (const [name, trail] of this.trails) {
      const { model } = trail;
      if (model.tMin === null) continue;
      const end = this.endsNow(name) && this.isOnline(name) ? Math.max(model.tMax, this.now()) : model.tMax;
      tMin = tMin === null ? model.tMin : Math.min(tMin, model.tMin);
      tMax = tMax === null ? end : Math.max(tMax, end);
      for (const tick of timelineTicks(model, this.shownMarksOn(name))) {
        ticks.push({ ...tick, color: trail.color });
      }
    }
    ticks.sort((a, b) => a.t - b.t);
    return { tMin, tMax, ticks };
  }

  /**
   * Where a player's ghost is drawn at a time of the replay, in map pixels:
   * `{x, y, plane}`; null when they have no trail or it starts later. While
   * their teleport is played out, that is where it has got to.
   */
  ghostAt(name, time, zoom) {
    const trail = this.trails.get(name);
    if (!trail) return null;
    const geometry = this.geometryOf(trail, lodForZoom(zoom));
    const hop = this.hopOn(name, geometry);
    return hop ? hopFocus(hop.jump, hop.progress) : placeAtTime(geometry, time);
  }

  /**
   * Where a player next turns up somewhere else, landing after `from` and up
   * to `to`: `{leave, land, kind}`, when they left, when they landed, and
   * whether it was a teleport, an entrance or a jump that can't be explained
   * ("unknown"). The next room of their house isn't somewhere else. Null when
   * they don't in that span, or have no trail.
   */
  nextHop(name, from, to) {
    const model = this.modelOf(name);
    if (!model) return null;
    for (const jump of model.jumps) {
      if (jump.kind === "house") continue;
      const land = model.points[jump.from + 1].t0;
      if (land > to) return null;
      if (land > from) return { leave: model.points[jump.from].t1, land, kind: jump.kind };
    }
    return null;
  }

  /**
   * When something next happens on any of the trails at or after a time, or
   * null when nothing does: a player moves (see nextChangeAfter), or an event
   * is marked, so that a replay which skips the waits doesn't skip those.
   */
  nextChangeAfter(time) {
    let next = null;
    for (const [name, trail] of this.trails) {
      const change = nextChangeAfter(trail.model, time);
      if (change !== null && (next === null || change < next)) next = change;
      // The first mark at or after the time; they are in order.
      const marks = this.shownMarksOn(name);
      let low = 0;
      let high = marks.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (marks[middle].t >= time) high = middle;
        else low = middle + 1;
      }
      const mark = marks[low];
      if (mark && (next === null || mark.t < next)) next = mark.t;
    }
    return next;
  }

  /**
   * Draws the trails, the selected player's on top. `view` is as the renderer
   * takes it. Returns whether something is animating.
   */
  draw(ctx, view, selectedName) {
    if (!this.trails.size) return false;
    const lod = lodForZoom(view.zoom);
    const names = this.names().sort((a, b) => Number(a === selectedName) - Number(b === selectedName));
    let animating = false;
    for (const name of names) {
      const trail = this.trails.get(name);
      const geometry = this.geometryOf(trail, lod);
      const mode =
        this.replayTime === null
          ? { kind: "live", windowS: trail.windowS, endS: trail.until }
          : { kind: "replay", time: this.replayTime, hop: this.hopOn(name, geometry) };
      const drawn = drawTrail(
        ctx,
        view,
        {
          model: trail.model,
          geometry,
          color: trail.color,
          light: trail.light,
          selected: name === selectedName,
          online: this.endsNow(name) && this.isOnline(name),
          hover: this.hover?.name === name ? this.hover.point : null,
        },
        mode,
      );
      animating = drawn || animating;
    }
    return animating;
  }

  /**
   * The trail point nearest to a place in map pixels, within `radius`:
   * `{name, index, point}`, or null.
   */
  hitTest(x, y, radius, zoom) {
    const lod = lodForZoom(zoom);
    let best = null;
    for (const [name, trail] of this.trails) {
      const hit = hitTest(this.geometryOf(trail, lod), x, y, radius);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { name, index: hit.src, point: trail.model.points[hit.src], distance: hit.distance };
      }
    }
    return best;
  }

  /** Highlights a point (as hitTest gives it). Returns whether that changed anything. */
  setHover(hit) {
    const changed = this.hover?.name !== hit?.name || this.hover?.index !== hit?.index;
    this.hover = hit || null;
    return changed;
  }
}
