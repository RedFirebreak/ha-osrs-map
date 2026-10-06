import { tileCenter } from "./map-space";
import { hopPhases, placeAtTime, pointOnArc, pointOnRun, vertexAtTime } from "./trail-geometry";
import { isNextRoom } from "./trail-model";

// Draws one trail on the map's canvas, in the map's own pixels (the camera
// transform is already set), so every size is divided by the zoom to come out
// in screen pixels.
//
// Live, a trail is a ribbon in the player's colour that fades and thins with
// age, with a glow where it meets the marker. In replay it is the whole route
// drawn faintly and, up to the time shown, an even bright line with a ghost of
// the player at its end. A teleport the replay plays out (`hop`: one of the
// geometry's jumps and how far it has got, 0..1) is drawn by that instead of
// by the time: the ghost vanishes, a spark runs along the arc, the ghost
// appears.
//
// view:  {zoom, plane, minX, minY, maxX, maxY, nowS, nowMs, reducedMotion}
// trail: {model, geometry, color, light, selected, online, hover}
// mode:  {kind: "live", windowS} | {kind: "replay", time, hop: {jump, progress} | null}

const OUTLINE = "#0a0f1e";
// The fade from new to old is stepped, so that long stretches share a stroke.
const AGE_BANDS = 12;
// Ages are compared on a log scale: the last hour takes as much of the fade
// as the day before it.
const AGE_SCALE_S = 600;
const OTHER_FLOOR_ALPHA = 0.3;
const CHEVRON_SPACING = 28;
const CHEVRON_SPEED = 18;
const MAX_CHEVRONS = 150;
const BURST_RAYS = 8;
const GHOST_RADIUS = 6.5;
// Far zoomed out a ghost of that size is lost among all there is on the map: it
// grows from the first zoom down to the second, to this many times its size.
const GHOST_GROWS_BELOW_ZOOM = 0.5;
const GHOST_GROWN_AT_ZOOM = 0.25;
const GHOST_GROWTH = 1.6;
// Where a player vanishes or appears in a teleport that is played out: how
// wide the rings around them start, and how high the streak of light rises.
const HOP_RINGS = [26, 15];
const HOP_STREAK = 38;

/** How new a moment is: 1 for now, 0 for the start of the window. */
export function ageFraction(t, nowS, windowS) {
  const age = Math.min(Math.max(nowS - t, 0), windowS);
  return 1 - Math.log(1 + age / AGE_SCALE_S) / Math.log(1 + windowS / AGE_SCALE_S);
}

// A trail that ended before now (`mode.endS`) is as old as it was then:
// measured from now, a session of last night would be faint from end to end.
function ageBand(t, view, mode) {
  return Math.min(AGE_BANDS - 1, Math.floor(ageFraction(t, mode.endS ?? view.nowS, mode.windowS) * AGE_BANDS));
}

/** The alpha and width (screen pixels) of the ribbon for an age band. */
function ribbonStyle(ageBandIndex, selected) {
  const k = (ageBandIndex + 0.5) / AGE_BANDS;
  return { alpha: 0.3 + 0.65 * k, width: selected ? 2.5 + 4.5 * k : 2 + 3.5 * k };
}

function inView(view, x, y, pad = 0) {
  return x >= view.minX - pad && x <= view.maxX + pad && y >= view.minY - pad && y <= view.maxY + pad;
}

function boxInView(view, box, pad = 0) {
  return (
    box[2] >= view.minX - pad && box[0] <= view.maxX + pad && box[3] >= view.minY - pad && box[1] <= view.maxY + pad
  );
}

function floorAlpha(plane, view) {
  return plane === view.plane ? 1 : OTHER_FLOOR_ALPHA;
}

/**
 * Walks a run's line up to `end` (a place as vertexAtTime gives it, or null
 * for all of it), calling `flush(key)` with a path of every stretch on screen
 * whose vertices share a `keyOf(vertex)`.
 */
function eachStretch(ctx, view, run, end, pad, keyOf, flush) {
  const last = end ? end.i : run.count - 1;
  for (const chunk of run.chunks) {
    if (chunk.i0 > last || (chunk.i0 === last && !end?.frac)) break;
    if (!boxInView(view, chunk.bbox, pad)) continue;
    let key = null;
    let open = false;
    const stop = Math.min(chunk.i1, last);
    for (let i = chunk.i0; i < stop; i++) {
      const next = keyOf(i);
      if (!open || next !== key) {
        if (open) flush(key);
        key = next;
        ctx.beginPath();
        ctx.moveTo(run.xy[i * 2], run.xy[i * 2 + 1]);
        open = true;
      }
      ctx.lineTo(run.xy[i * 2 + 2], run.xy[i * 2 + 3]);
    }
    if (end && end.frac && last >= chunk.i0 && last < chunk.i1) {
      const next = keyOf(last);
      if (!open || next !== key) {
        if (open) flush(key);
        key = next;
        ctx.beginPath();
        ctx.moveTo(run.xy[last * 2], run.xy[last * 2 + 1]);
        open = true;
      }
      const [x, y] = pointOnRun(run, end);
      ctx.lineTo(x, y);
    }
    if (open) flush(key);
  }
}

function dot(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
}

function setDash(ctx, view, pattern) {
  ctx.setLineDash(pattern.map((length) => length / view.zoom));
}

/** Rays around a point: where a player vanished or turned up. */
function burst(ctx, view, x, y, color, alpha) {
  const inner = 4 / view.zoom;
  const outer = 9 / view.zoom;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let ray = 0; ray < BURST_RAYS; ray++) {
    const angle = (ray / BURST_RAYS) * Math.PI * 2;
    ctx.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    ctx.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
  }
  ctx.lineCap = "round";
  ctx.globalAlpha = alpha * 0.7;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3.5 / view.zoom;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6 / view.zoom;
  ctx.stroke();
}

/** A ring around a point: a way down into, or up out of, the underground. */
function ring(ctx, view, x, y, color, alpha) {
  ctx.setLineDash([]);
  dot(ctx, x, y, 6 / view.zoom);
  ctx.globalAlpha = alpha * 0.7;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 4 / view.zoom;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / view.zoom;
  ctx.stroke();
}

/**
 * A small mark above a point, clear of the line that starts there: the player
 * walked into this room from the one before. With a roof it is a little
 * house, for a room of their own house; without one a plain square of the
 * same width, for a room of a raid, which is nobody's house.
 */
function room(ctx, view, x, tileY, color, alpha, roofed) {
  const size = 4 / view.zoom;
  const y = tileY - 12 / view.zoom;
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - size, y + size);
  if (roofed) {
    ctx.lineTo(x - size, y - size * 0.25);
    ctx.lineTo(x, y - size * 1.25);
    ctx.lineTo(x + size, y - size * 0.25);
  } else {
    ctx.lineTo(x - size, y - size);
    ctx.lineTo(x + size, y - size);
  }
  ctx.lineTo(x + size, y + size);
  ctx.closePath();
  ctx.globalAlpha = alpha * 0.7;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3.5 / view.zoom;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 / view.zoom;
  ctx.stroke();
}

/** A short dashed line straight up: the other end is on another part of the map. */
function stub(ctx, view, x, y, color, alpha) {
  setDash(ctx, view, [4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, y - 10 / view.zoom);
  ctx.lineTo(x, y - 34 / view.zoom);
  ctx.globalAlpha = alpha * 0.8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / view.zoom;
  ctx.stroke();
}

/** A stroke with a dark edge, along the path that is open. */
function edged(ctx, view, color, width, alpha) {
  ctx.globalAlpha = alpha * 0.6;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = (width + 2) / view.zoom;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width / view.zoom;
  ctx.stroke();
}

/**
 * A jump, as far as `progress` (0..1) of it has happened: the mark where the
 * player left, the link to where they turned up and, once there, its mark.
 * Returns whether it drew dashes that move (`animate`, an arc on screen).
 */
function drawJump(ctx, view, trail, jump, alpha, progress, animate) {
  const { ax, ay, bx, by, kind } = jump;
  const pad = 40 / view.zoom;
  const arrived = progress >= 1;
  const alphaA = alpha * floorAlpha(jump.planeA, view);
  const alphaB = alpha * floorAlpha(jump.planeB, view);
  let moving = false;

  if (kind === "unknown" || jump.arc) {
    const box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    const reach = jump.arc ? Math.hypot(bx - ax, by - ay) * 0.1 + pad : pad;
    if (boxInView(view, box, reach)) {
      ctx.lineCap = "round";
      ctx.lineDashOffset = 0;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      if (jump.arc) {
        const pieces = jump.arc.length / 2 - 1;
        const upTo = Math.floor(progress * pieces);
        for (let s = 1; s <= upTo; s++) ctx.lineTo(jump.arc[s * 2], jump.arc[s * 2 + 1]);
        if (progress * pieces > upTo) ctx.lineTo(...pointOnArc(jump.arc, progress));
        setDash(ctx, view, [6, 6]);
        if (animate) ctx.lineDashOffset = -((view.nowMs / 40) % 12) / view.zoom;
        moving = animate;
        edged(ctx, view, trail.light, 2, Math.max(alphaA, alphaB));
      } else {
        ctx.lineTo(ax + (bx - ax) * progress, ay + (by - ay) * progress);
        setDash(ctx, view, [0.01, 7]);
        edged(ctx, view, trail.color, 2.5, Math.max(alphaA, alphaB) * 0.6);
      }
      ctx.lineDashOffset = 0;
    }
  }
  if (kind === "unknown") return moving;
  if (isNextRoom(kind)) {
    // Walked, so nothing where they left and no link: only the room they came into.
    if (arrived && inView(view, bx, by, pad)) room(ctx, view, bx, by, trail.light, alphaB, kind === "house");
    return moving;
  }

  for (const [x, y, endAlpha, shown] of [
    [ax, ay, alphaA, true],
    [bx, by, alphaB, arrived],
  ]) {
    if (!shown || !inView(view, x, y, pad)) continue;
    if (kind === "entrance") {
      ring(ctx, view, x, y, trail.light, endAlpha);
    } else {
      if (jump.crossBand) stub(ctx, view, x, y, trail.light, endAlpha);
      burst(ctx, view, x, y, trail.light, endAlpha);
    }
  }
  return moving;
}

/** Little arrow heads flowing along the line towards the player. */
function drawChevrons(ctx, view, trail, mode) {
  const spacing = CHEVRON_SPACING / view.zoom;
  const size = 3.4 / view.zoom;
  const moved = view.reducedMotion ? 0 : (((view.nowMs / 1000) * CHEVRON_SPEED) % CHEVRON_SPACING) / view.zoom;
  let drawn = 0;
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Newest first, so that the limit is spent near the player.
  const runs = trail.geometry.runs;
  for (let r = runs.length - 1; r >= 0; r--) {
    const run = runs[r];
    if (run.count < 2) continue;
    const total = run.cum[run.count - 1];
    // Counted back from the end of the run, so new points don't shift them.
    const first = total - (spacing - moved);
    for (let c = run.chunks.length - 1; c >= 0; c--) {
      const chunk = run.chunks[c];
      if (!boxInView(view, chunk.bbox, spacing)) continue;
      let i = chunk.i0;
      // The chevrons that fall on this chunk are numbers `from` to `to`, counting from the end.
      const from = Math.max(Math.ceil((first - run.cum[chunk.i1]) / spacing), 0);
      const to = Math.floor((first - run.cum[chunk.i0]) / spacing);
      for (let k = to; k >= from && drawn < MAX_CHEVRONS; k--) {
        const along = first - k * spacing;
        while (i < chunk.i1 - 1 && run.cum[i + 1] < along) i += 1;
        const length = run.cum[i + 1] - run.cum[i];
        if (length <= 0) continue;
        if (run.plane[i] !== view.plane || ageBand(run.t[i], view, mode) < AGE_BANDS / 4) continue;
        const dx = (run.xy[i * 2 + 2] - run.xy[i * 2]) / length;
        const dy = (run.xy[i * 2 + 3] - run.xy[i * 2 + 1]) / length;
        const u = (along - run.cum[i]) / length;
        const x = run.xy[i * 2] + dx * length * u;
        const y = run.xy[i * 2 + 1] + dy * length * u;
        ctx.moveTo(x - dx * size - dy * size, y - dy * size + dx * size);
        ctx.lineTo(x, y);
        ctx.lineTo(x - dx * size + dy * size, y - dy * size - dx * size);
        drawn += 1;
      }
    }
  }
  if (!drawn) return false;
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = trail.light;
  ctx.lineWidth = 1.5 / view.zoom;
  ctx.stroke();
  return true;
}

function drawLive(ctx, view, trail, mode) {
  const { geometry, selected } = trail;
  const pad = 12 / view.zoom;
  let animating = false;

  for (const jump of geometry.jumps) {
    const alpha = ribbonStyle(ageBand(jump.tB, view, mode), selected).alpha;
    const animate = selected && !view.reducedMotion && Boolean(jump.arc);
    animating = drawJump(ctx, view, trail, jump, alpha, 1, animate) || animating;
  }

  ctx.lineJoin = "round";
  const bands = AGE_BANDS;
  for (const pass of ["outline", "color"]) {
    for (const run of geometry.runs) {
      if (!boxInView(view, run.bbox, pad)) continue;
      if (run.sail) setDash(ctx, view, [7, 5]);
      else ctx.setLineDash([]);
      ctx.lineCap = run.sail || pass === "outline" ? "butt" : "round";
      // The key packs the age band with whether the vertex is on the floor shown.
      const keyOf = (i) => ageBand(run.t[i + 1] ?? run.t[i], view, mode) + (run.plane[i] === view.plane ? 0 : bands);
      const style = (key) => {
        const ribbon = ribbonStyle(key % bands, selected);
        return { alpha: ribbon.alpha * (key >= bands ? OTHER_FLOOR_ALPHA : 1), width: ribbon.width };
      };
      if (run.count === 1) {
        if (pass === "outline" || !inView(view, run.xy[0], run.xy[1], pad)) continue;
        const { alpha, width } = style(keyOf(0));
        dot(ctx, run.xy[0], run.xy[1], (width * 0.9) / view.zoom);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = trail.color;
        ctx.fill();
        continue;
      }
      eachStretch(ctx, view, run, null, pad, keyOf, (key) => {
        const { alpha, width } = style(key);
        ctx.globalAlpha = pass === "outline" ? alpha * 0.6 : alpha;
        ctx.strokeStyle = pass === "outline" ? OUTLINE : trail.color;
        ctx.lineWidth = (pass === "outline" ? width + 2 : width) / view.zoom;
        ctx.stroke();
      });
    }
  }

  if (selected && geometry.lod < 2) {
    animating = (drawChevrons(ctx, view, trail, mode) && !view.reducedMotion) || animating;
  }

  const runs = geometry.runs;
  if (runs.length) {
    ctx.setLineDash([]);
    const start = runs[0];
    if (inView(view, start.xy[0], start.xy[1], pad)) {
      dot(ctx, start.xy[0], start.xy[1], 3 / view.zoom);
      ctx.globalAlpha = 0.6 * floorAlpha(start.plane[0], view);
      ctx.fillStyle = trail.color;
      ctx.fill();
    }
    const end = runs[runs.length - 1];
    const x = end.xy[end.count * 2 - 2];
    const y = end.xy[end.count * 2 - 1];
    if (inView(view, x, y, 20 / view.zoom)) {
      const alpha = floorAlpha(end.plane[end.count - 1], view);
      if (trail.online) {
        // A soft glow under the marker.
        ctx.fillStyle = trail.light;
        for (const [radius, glow] of [
          [16, 0.14],
          [10, 0.22],
        ]) {
          dot(ctx, x, y, radius / view.zoom);
          ctx.globalAlpha = glow * alpha;
          ctx.fill();
        }
      } else {
        // The trail ends here: the player logged out.
        dot(ctx, x, y, 4.5 / view.zoom);
        edged(ctx, view, trail.light, 1.5, alpha);
      }
    }
  }

  return animating;
}

function drawReplay(ctx, view, trail, mode) {
  const { geometry } = trail;
  const time = mode.time;
  const pad = 12 / view.zoom;
  const onFloor = (run) => (i) => (run.plane[i] === view.plane ? 0 : 1);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // The whole route, faintly.
  ctx.setLineDash([]);
  ctx.strokeStyle = trail.color;
  ctx.lineWidth = 2 / view.zoom;
  for (const run of geometry.runs) {
    if (run.count < 2 || !boxInView(view, run.bbox, pad)) continue;
    eachStretch(ctx, view, run, null, pad, onFloor(run), (key) => {
      ctx.globalAlpha = key ? 0.1 : 0.22;
      ctx.stroke();
    });
  }

  // While a teleport is played out, what came after it has yet to happen. The
  // time alone doesn't say so: the hub's times are whole seconds, and leaving,
  // landing and the next step can share one.
  const hopFrom = mode.hop ? mode.hop.jump.from : Infinity;

  // What has happened by now, brightly.
  for (const run of geometry.runs) {
    if (run.i0 > hopFrom) continue;
    const end = vertexAtTime(run, time);
    if (!end) continue;
    if (run.count < 2 || !boxInView(view, run.bbox, pad)) continue;
    for (const [color, width, alpha] of [
      [OUTLINE, 6, 0.7],
      [trail.color, 4, 1],
      [trail.light, 1.5, 0.9],
    ]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width / view.zoom;
      eachStretch(ctx, view, run, end, pad, onFloor(run), (key) => {
        ctx.globalAlpha = alpha * (key ? OTHER_FLOOR_ALPHA : 1);
        ctx.stroke();
      });
    }
  }
  for (const jump of geometry.jumps) {
    if (time < jump.tA || jump.from >= hopFrom) continue;
    const progress = jump.tB > jump.tA ? Math.min(1, (time - jump.tA) / (jump.tB - jump.tA)) : 1;
    drawJump(ctx, view, trail, jump, 1, progress, false);
  }

  if (mode.hop) {
    drawHop(ctx, view, trail, mode.hop);
    return false;
  }
  const ghost = placeAtTime(geometry, time);
  if (ghost && inView(view, ghost.x, ghost.y, pad)) drawGhost(ctx, view, trail, ghost.x, ghost.y, ghost.plane);
  return false;
}

/** The ghost's radius on screen at a zoom, in pixels. */
function ghostRadius(zoom) {
  const grown = (GHOST_GROWS_BELOW_ZOOM - zoom) / (GHOST_GROWS_BELOW_ZOOM - GHOST_GROWN_AT_ZOOM);
  return GHOST_RADIUS * (1 + (GHOST_GROWTH - 1) * Math.min(Math.max(grown, 0), 1));
}

/** The player in a replay: a dot in their colour, `scale` (0..1) of its full size. */
function drawGhost(ctx, view, trail, x, y, plane, scale = 1) {
  if (scale <= 0) return;
  ctx.setLineDash([]);
  dot(ctx, x, y, (ghostRadius(view.zoom) * scale) / view.zoom);
  ctx.globalAlpha = floorAlpha(plane, view) < 1 ? 0.5 : 1;
  ctx.fillStyle = trail.color;
  ctx.fill();
  ctx.strokeStyle = "white";
  ctx.lineWidth = (2 * scale) / view.zoom;
  ctx.stroke();
}

/**
 * The ghost vanishing in a teleport: `gone` is 0 while it stands there as
 * ever and 1 when nothing is left. In between it shrinks inside rings that
 * close in on it, while a streak of light leaves the ground. Played backwards
 * (1 to 0) it is the ghost appearing.
 */
function drawVanishing(ctx, view, trail, x, y, plane, gone) {
  if (!inView(view, x, y, (HOP_STREAK + 4) / view.zoom)) return;
  // The light is at its brightest halfway and out at both ends.
  const light = Math.sin(Math.PI * gone) * floorAlpha(plane, view);
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  if (light > 0) {
    dot(ctx, x, y, 17 / view.zoom);
    ctx.globalAlpha = 0.3 * light;
    ctx.fillStyle = trail.light;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y - (HOP_STREAK * gone * gone) / view.zoom);
    ctx.lineTo(x, y - (HOP_STREAK * gone) / view.zoom);
    edged(ctx, view, trail.light, 3, light);
    for (const reach of HOP_RINGS) {
      dot(ctx, x, y, (GHOST_RADIUS + (reach - GHOST_RADIUS) * (1 - gone)) / view.zoom);
      edged(ctx, view, trail.light, 2, light);
    }
  }
  drawGhost(ctx, view, trail, x, y, plane, 1 - gone * gone);
}

/** A teleport as far as the replay has played it out; see hopPhases. */
function drawHop(ctx, view, trail, { jump, progress }) {
  const { depart, travel, arrive } = hopPhases(progress);
  drawJump(ctx, view, trail, jump, 1, travel, false);
  if (depart < 1) {
    drawVanishing(ctx, view, trail, jump.ax, jump.ay, jump.planeA, depart);
  } else if (travel >= 1) {
    drawVanishing(ctx, view, trail, jump.bx, jump.by, jump.planeB, 1 - arrive);
  } else if (jump.arc) {
    // Under way: a spark at the head of the arc.
    const [x, y] = pointOnArc(jump.arc, travel);
    if (!inView(view, x, y, 12 / view.zoom)) return;
    const alpha = Math.max(floorAlpha(jump.planeA, view), floorAlpha(jump.planeB, view));
    ctx.setLineDash([]);
    ctx.fillStyle = trail.light;
    dot(ctx, x, y, 11 / view.zoom);
    ctx.globalAlpha = 0.3 * alpha;
    ctx.fill();
    dot(ctx, x, y, 4 / view.zoom);
    ctx.globalAlpha = alpha;
    ctx.fill();
  }
}

/** Draws a trail. Returns whether it is animating and wants another frame. */
export function drawTrail(ctx, view, trail, mode) {
  if (!trail.model.points.length) return false;
  ctx.save();
  const animating = mode.kind === "replay" ? drawReplay(ctx, view, trail, mode) : drawLive(ctx, view, trail, mode);
  if (trail.hover) {
    const [x, y] = tileCenter(trail.hover.x, trail.hover.y);
    ctx.setLineDash([]);
    dot(ctx, x, y, 6 / view.zoom);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2 / view.zoom;
    ctx.stroke();
  }
  ctx.restore();
  return animating;
}
