import { beforeEach, describe, expect, it } from "vitest";
import { TrailLayer } from "../src/canvas-map/trail-layer";
import { tileCenter } from "../src/canvas-map/map-space";

const T = 1_790_000_040;
const COLORS = { color: "hsl(1, 70%, 45%)", light: "hsl(1, 85%, 70%)", windowS: 86400 };

/** A trail as the server sends it: one tile east per minute from (3200, 3200). */
function history(minutes = 3) {
  return {
    step: 60,
    points: Array.from({ length: minutes }, (_, i) => [3200 + i * 10, 3200, 0, T + i * 60]),
    worlds: [[0, 302]],
  };
}

const tile = (x, y = 3201, plane = 0) => ({ x, y, plane });

/** A hub event of Alice's, so many seconds after T. */
const event = (id, seconds, extra = {}) => ({
  id,
  type: "death",
  member: "Alice",
  occurred_at: new Date((T + seconds) * 1000).toISOString(),
  ...extra,
});

describe("TrailLayer", () => {
  let now, layer;

  beforeEach(() => {
    now = T + 130;
    layer = new TrailLayer({ now: () => now });
  });

  it("shows the trails it was given", () => {
    layer.setHistory("Alice", history(), COLORS);
    expect(layer.names()).toEqual(["Alice"]);
    expect(layer.modelOf("Alice").points).toHaveLength(3);
    layer.remove("Alice");
    expect(layer.names()).toEqual([]);
  });

  it("ends an online player's trail on their marker", () => {
    layer.setHistory("Alice", history(), COLORS);
    now = T + 200;
    expect(layer.observe("Alice", tile(3235), true)).toBe(true);
    const points = layer.modelOf("Alice").points;
    expect(points[points.length - 1]).toMatchObject({ x: 3235, y: 3201, t1: T + 200, live: true });
    expect(layer.isOnline("Alice")).toBe(true);
  });

  it("remembers where a player was seen before their trail was switched on", () => {
    layer.observe("Alice", tile(3235), true);
    // The hub's answer is the one from before they got there.
    layer.setHistory("Alice", { ...history(), as_of: T + 125 }, COLORS);
    const points = layer.modelOf("Alice").points;
    expect(points[points.length - 1]).toMatchObject({ x: 3235 });
  });

  it("leaves out where a player was seen before the hub gave their trail", () => {
    layer.observe("Alice", tile(3215), true);
    now = T + 135;
    layer.observe("Alice", tile(3220), true);
    // Given now, so with the tile the marker has just left in it.
    layer.setHistory("Alice", history(), COLORS);
    expect(layer.modelOf("Alice").points.map((point) => point.x)).toEqual([3200, 3210, 3220]);
  });

  describe("with a trail that ended before now (a session that is over)", () => {
    const over = { ...COLORS, windowS: 180, until: T + 180 };

    it("leaves the trail where it ended, wherever the player is now", () => {
      layer.observe("Alice", tile(3500), true);
      layer.setHistory("Alice", history(), over);
      const ended = layer.modelOf("Alice").points;
      expect(ended).toHaveLength(3);
      expect(ended[2]).toMatchObject({ x: 3220, t1: T + 120 });
      // Nor does it grow when they move on.
      now = T + 200;
      expect(layer.observe("Alice", tile(3510), true)).toBe(false);
      expect(layer.modelOf("Alice").points).toHaveLength(3);
    });

    it("has a timeline that ends with the trail", () => {
      layer.observe("Alice", tile(3500), true);
      layer.setHistory("Alice", history(), over);
      now = T + 5000;
      expect(layer.timeline()).toMatchObject({ tMin: T, tMax: T + 120 });
    });

    it("grows again when the trail is asked for until now", () => {
      layer.observe("Alice", tile(3500), true);
      layer.setHistory("Alice", history(), over);
      layer.setHistory("Alice", history(), COLORS);
      const points = layer.modelOf("Alice").points;
      expect(points[points.length - 1]).toMatchObject({ x: 3500, live: true });
    });
  });

  describe("with a trail over a session that still goes on", () => {
    // The session began ten minutes after T; the map asked for it from there.
    const FROM = T + 600;
    const open = { ...COLORS, windowS: 300, until: null, from: FROM };
    const nothing = { step: 60, points: [] };

    /** Alice was seen walking east a few minutes before the session began. */
    function seenBefore(online = false) {
      for (const [seconds, x] of [
        [200, 3230],
        [260, 3240],
        [320, 3250],
      ]) {
        now = T + seconds;
        layer.observe("Alice", tile(x), true);
      }
      now = T + 380;
      layer.observe("Alice", tile(3250), online);
      now = T + 900;
    }

    it("shows nothing of a player the hub has no points of in it, wherever they were seen before", () => {
      seenBefore();
      layer.setHistory("Alice", nothing, open);
      expect(layer.modelOf("Alice").points).toEqual([]);
      // And the replay has nothing of theirs to start at.
      expect(layer.timeline()).toEqual({ tMin: null, tMax: null, ticks: [] });
    });

    it("starts the replay where the session's own trail starts, not at an older sighting of someone else", () => {
      seenBefore();
      layer.setHistory("Alice", nothing, open);
      layer.setHistory("Bob", { step: 60, points: [[3000, 3000, 0, FROM + 30]] }, open);
      expect(layer.timeline()).toMatchObject({ tMin: FROM + 30, tMax: FROM + 30 });
    });

    it("has a player who stood there since before it began stand there from its start", () => {
      seenBefore(true);
      layer.observe("Alice", tile(3250), true);
      layer.setHistory("Alice", nothing, open);
      expect(layer.modelOf("Alice").points.map((point) => [point.x, point.t0, point.t1])).toEqual([
        [3250, FROM, T + 900],
      ]);
    });

    it("still grows with where the player goes", () => {
      seenBefore();
      layer.setHistory("Alice", nothing, open);
      now = T + 960;
      expect(layer.observe("Alice", tile(3300), true)).toBe(true);
      expect(layer.modelOf("Alice").points.map((point) => [point.x, point.t0])).toEqual([[3300, T + 960]]);
    });

    it("is what it was for a trail asked for in days", () => {
      seenBefore();
      layer.setHistory("Alice", nothing, COLORS);
      expect(layer.modelOf("Alice").points.map((point) => point.x)).toEqual([3230, 3240, 3250]);
    });
  });

  it("does not report a change for a player whose trail isn't shown", () => {
    expect(layer.observe("Bob", tile(3000), true)).toBe(false);
    expect(layer.names()).toEqual([]);
  });

  it("ends an offline player's trail where the hub last saw them", () => {
    layer.observe("Alice", tile(3235), true);
    now = T + 135;
    layer.setHistory("Alice", history(), COLORS);
    expect(layer.observe("Alice", null, false)).toBe(true);
    const points = layer.modelOf("Alice").points;
    expect(points[points.length - 1]).toMatchObject({ x: 3220 });
    expect(layer.isOnline("Alice")).toBe(false);
  });

  it("shows the time a player was logged out as a gap, not as standing still", () => {
    layer.setHistory("Alice", history(), COLORS);
    now = T + 300;
    layer.observe("Alice", tile(3230), true);
    now = T + 400;
    layer.observe("Alice", tile(3230), false);
    now = T + 1500;
    layer.observe("Alice", tile(3230), true);
    const model = layer.modelOf("Alice");
    expect(model.points.slice(-2).map((point) => [point.x, point.t0])).toEqual([
      [3230, T + 300],
      [3230, T + 1500],
    ]);
    expect(model.kinds[model.kinds.length - 1]).toBe("unknown");
  });

  it("keeps the live points when the history is fetched again", () => {
    layer.setHistory("Alice", history(), COLORS);
    for (const [seconds, x] of [
      [200, 3230],
      [260, 3240],
      [320, 3250],
    ]) {
      now = T + seconds;
      layer.observe("Alice", tile(x), true);
    }
    // The same answer again: the hub wasn't asked in between.
    layer.setHistory("Alice", { ...history(), as_of: T + 130 }, COLORS);
    expect(layer.modelOf("Alice").points.map((point) => point.x)).toEqual([3200, 3210, 3220, 3230, 3240, 3250]);

    // The hub caught up with two of them: its samples replace the live ones.
    layer.setHistory("Alice", { ...history(5), as_of: T + 300 }, COLORS);
    expect(layer.modelOf("Alice").points.map((point) => point.x)).toEqual([3200, 3210, 3220, 3230, 3240, 3250]);
    expect(layer.modelOf("Alice").points.filter((point) => point.live)).toHaveLength(1);
  });

  it("gives the time span and the ticks of everything shown", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setHistory(
      "Bob",
      {
        step: 60,
        points: [
          [3000, 3000, 0, T - 600],
          [2400, 3000, 0, T - 540],
        ],
      },
      COLORS,
    );
    layer.setEvents("Alice", [event("d", 30)]);
    const timeline = layer.timeline();
    expect([timeline.tMin, timeline.tMax]).toEqual([T - 600, T + 120]);
    expect(timeline.ticks).toEqual([
      { t: T - 540, kind: "teleport", color: COLORS.color },
      { t: T + 30, kind: "death", tier: 0, color: COLORS.color },
    ]);
    expect(new TrailLayer().timeline()).toEqual({ tMin: null, tMax: null, ticks: [] });
  });

  it("says when something next happens on any of the trails", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setHistory(
      "Bob",
      {
        step: 60,
        points: [
          [3000, 3000, 0, T + 400, 700],
          [3010, 3000, 0, T + 460],
        ],
      },
      COLORS,
    );
    // Alice is under way.
    expect(layer.nextChangeAfter(T + 30)).toBe(T + 30);
    // Alice is done; Bob stays where he is until T + 400.
    expect(layer.nextChangeAfter(T + 121)).toBe(T + 400);
    expect(layer.nextChangeAfter(T + 500)).toBeNull();
    expect(new TrailLayer().nextChangeAfter(T)).toBeNull();
  });

  it("leaves out events from before the trail starts", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setEvents("Alice", [event("old", -5000)]);
    expect(layer.timeline().ticks).toEqual([]);
    expect(layer.marksOn("Alice")).toEqual([]);
  });

  it("forgets a player's events with their trail", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setHistory("Bob", history(), COLORS);
    layer.setEvents("Alice", [event("d", 30)]);
    layer.setEvents("Bob", [event("b", 30, { member: "Bob" })]);
    layer.remove("Alice");
    layer.setHistory("Alice", history(), COLORS);
    expect(layer.marksOn("Alice")).toEqual([]);
    expect(layer.marksOn("Bob")).toHaveLength(1);

    layer.clear();
    layer.setHistory("Bob", history(), COLORS);
    expect(layer.marksOn("Bob")).toEqual([]);
  });

  it("marks a player's events on their trail, whichever comes first", () => {
    layer.setEvents("Alice", [event("d", 30, { type: "level_up" })]);
    expect(layer.marksOn("Alice")).toEqual([]);
    layer.setHistory("Alice", history(), COLORS);
    expect(layer.marksOn("Alice")).toMatchObject([{ id: "d", x: 3205, y: 3201, t: T + 30 }]);
    expect(layer.colorOf("Alice")).toBe(COLORS.color);

    layer.setEvents("Alice", [event("d", 30, { type: "level_up" }), event("e", 90)]);
    expect(layer.marksOn("Alice").map((mark) => mark.id)).toEqual(["d", "e"]);
  });

  it("marks a new event at the end of a trail that has grown to it", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setEvents("Alice", [event("late", 600, { type: "level_up" })]);
    expect(layer.marksOn("Alice")).toEqual([]);
    now = T + 600;
    layer.observe("Alice", tile(3260), true);
    expect(layer.marksOn("Alice")).toMatchObject([{ id: "late", x: 3260 }]);
  });

  it("keeps the events the map hides off the timeline", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setEvents("Alice", [event("d", 30), event("l", 60, { type: "level_up" })]);
    layer.setEventFilter((candidate) => candidate.type !== "death");
    expect(layer.timeline().ticks.map((tick) => tick.kind)).toEqual(["level"]);
    // On the map they are still to be had: the map filters for itself.
    expect(layer.marksOn("Alice")).toHaveLength(2);
  });

  it("follows the filter when what it lets through changes", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setEvents("Alice", [event("d", 30), event("l", 60, { type: "level_up" })]);
    let hidden = "death";
    layer.setEventFilter((candidate) => candidate.type !== hidden);
    expect(layer.timeline().ticks.map((tick) => tick.kind)).toEqual(["level"]);
    hidden = "level_up";
    layer.eventFilterChanged();
    expect(layer.timeline().ticks.map((tick) => tick.kind)).toEqual(["death"]);
    // New events are filtered too.
    layer.setEvents("Alice", [event("d", 30), event("d2", 90)]);
    expect(layer.timeline().ticks.map((tick) => tick.kind)).toEqual(["death", "death"]);
  });

  it("counts an event as something that happens, so a replay doesn't skip it", () => {
    layer.setHistory(
      "Alice",
      {
        step: 60,
        points: [
          [3200, 3200, 0, T + 3600, 3600],
          [3210, 3200, 0, T + 3660],
        ],
      },
      COLORS,
    );
    // An hour on one tile: nothing happens until it ends.
    expect(layer.nextChangeAfter(T + 10)).toBe(T + 3600);
    layer.setEvents("Alice", [event("l", 1200, { type: "level_up" })]);
    expect(layer.nextChangeAfter(T + 10)).toBe(T + 1200);
    expect(layer.nextChangeAfter(T + 1200)).toBe(T + 1200);
    expect(layer.nextChangeAfter(T + 1201)).toBe(T + 3600);
  });

  it("finds the point of a trail under the pointer", () => {
    layer.setHistory("Alice", history(), COLORS);
    const [x, y] = tileCenter(3211, 3201);
    const hit = layer.hitTest(x, y + 2, 8, 2);
    expect(hit).toMatchObject({ name: "Alice", index: 1 });
    expect(hit.point).toMatchObject({ x: 3210, y: 3201, world: 302 });
    expect(layer.hitTest(x, y + 40, 8, 2)).toBeNull();
  });

  /** Bob teleports west, walks a little, and goes down into a dungeon. */
  const hopper = () => ({
    step: 60,
    points: [
      [3000, 3000, 0, T - 600],
      [2400, 3000, 0, T - 540],
      [2410, 3000, 0, T - 480],
      [2410, 9400, 0, T - 420],
    ],
  });

  it("says where a player next hops: when they leave, when they land and how", () => {
    layer.setHistory("Alice", history(), COLORS);
    layer.setHistory("Bob", hopper(), COLORS);
    expect(layer.modelOf("Bob").kinds).toEqual(["teleport", "walk", "entrance"]);
    const teleport = { leave: T - 600, land: T - 540, kind: "teleport" };
    expect(layer.nextHop("Bob", T - 600, T - 500)).toEqual(teleport);
    expect(layer.nextHop("Bob", T - 600, T)).toEqual(teleport);
    // From just after one landing, the next.
    expect(layer.nextHop("Bob", T - 540, T)).toEqual({ leave: T - 480, land: T - 420, kind: "entrance" });
    expect(layer.nextHop("Bob", T - 600, T - 541)).toBeNull();
    expect(layer.nextHop("Alice", T - 600, T + 600)).toBeNull();
    expect(layer.nextHop("Nobody", T - 600, T)).toBeNull();
  });

  it("doesn't count the next room of a house as a hop", () => {
    layer.setHistory(
      "Bob",
      {
        step: 60,
        points: [
          [3000, 3000, 0, T - 600],
          [1900, 7050, 0, T - 540, 0, 0, 4],
          [1964, 7058, 0, T - 480, 0, 0, 3],
          [3222, 3218, 0, T - 420, 0, 0, 4],
        ],
      },
      COLORS,
    );
    expect(layer.modelOf("Bob").kinds).toEqual(["teleport", "house", "teleport"]);
    expect(layer.nextHop("Bob", T - 540, T)).toMatchObject({ land: T - 420, kind: "teleport" });
  });

  it("doesn't count the next room of a raid as a hop, nor as a tick on the timeline", () => {
    layer.setHistory(
      "Bob",
      {
        step: 60,
        points: [
          [3030, 6120, 0, T - 600],
          [1860, 5640, 0, T - 540, 0, 0, 4],
          [1910, 5690, 0, T - 480, 0, 0, 6],
          [3030, 6120, 0, T - 420, 0, 0, 4],
        ],
      },
      COLORS,
    );
    expect(layer.modelOf("Bob").kinds).toEqual(["teleport", "instance", "teleport"]);
    expect(layer.nextHop("Bob", T - 540, T)).toMatchObject({ land: T - 420, kind: "teleport" });
    expect(layer.timeline().ticks.map((tick) => tick.t)).toEqual([T - 540, T - 420]);
  });

  it("holds the replay for a step with a label nobody knows, as for any jump it can't explain", () => {
    layer.setHistory(
      "Bob",
      {
        step: 60,
        points: [
          [3000, 3000, 0, T - 600],
          [3003, 3000, 0, T - 540, 0, 0, 7],
        ],
      },
      COLORS,
    );
    expect(layer.modelOf("Bob").kinds).toEqual(["unknown"]);
    expect(layer.nextHop("Bob", T - 600, T)).toEqual({ leave: T - 600, land: T - 540, kind: "unknown" });
  });

  describe("while a teleport is played out", () => {
    const hop = (progress, name = "Bob") => ({ name, leave: T - 600, land: T - 540, progress });

    beforeEach(() => {
      layer.setHistory("Alice", history(), COLORS);
      layer.setHistory("Bob", hopper(), COLORS);
    });

    it("has the player's ghost where the teleport has got to, not where the time says", () => {
      const [ax, ay] = tileCenter(3000, 3001);
      const [bx, by] = tileCenter(2400, 3001);
      layer.setReplay(T - 600, hop(0.1));
      expect(layer.ghostAt("Bob", T - 600, 2)).toEqual({ x: ax, y: ay, plane: 0 });
      layer.setReplay(T - 600, hop(0.5));
      const middle = layer.ghostAt("Bob", T - 600, 2);
      expect(middle.x).toBeLessThan(ax);
      expect(middle.x).toBeGreaterThan(bx);
      layer.setReplay(T - 600, hop(0.9));
      expect(layer.ghostAt("Bob", T - 600, 2)).toEqual({ x: bx, y: by, plane: 0 });
    });

    it("leaves the other players where the time has them", () => {
      layer.setReplay(T + 60, hop(0.5));
      const [x, y] = tileCenter(3210, 3201);
      expect(layer.ghostAt("Alice", T + 60, 2)).toEqual({ x, y, plane: 0 });
    });

    it("is over once the replay moves on without one", () => {
      const [ax, ay] = tileCenter(3000, 3001);
      layer.setReplay(T - 600, hop(0.5));
      layer.setReplay(T - 600);
      expect(layer.ghostAt("Bob", T - 600, 2)).toEqual({ x: ax, y: ay, plane: 0 });
    });

    it("goes by the time when the trail has no such teleport any more", () => {
      const [ax, ay] = tileCenter(3000, 3001);
      layer.setReplay(T - 600, { ...hop(0.5), land: T - 500 });
      expect(layer.ghostAt("Bob", T - 600, 2)).toEqual({ x: ax, y: ay, plane: 0 });
    });
  });

  it("says where a player was at a time of the replay", () => {
    layer.setHistory("Alice", history(), COLORS);
    const [x, y] = tileCenter(3210, 3201);
    expect(layer.ghostAt("Alice", T + 60, 2)).toEqual({ x, y, plane: 0 });
    expect(layer.ghostAt("Alice", T - 100, 2)).toBeNull();
    expect(layer.ghostAt("Nobody", T + 60, 2)).toBeNull();
  });

  it("says whether the hovered point changed", () => {
    layer.setHistory("Alice", history(), COLORS);
    const [x, y] = tileCenter(3210, 3201);
    const hit = layer.hitTest(x, y, 8, 2);
    expect(layer.setHover(hit)).toBe(true);
    expect(layer.setHover(layer.hitTest(x, y, 8, 2))).toBe(false);
    expect(layer.setHover(null)).toBe(true);
  });

  it("draws nothing and wants no frames without trails", () => {
    expect(layer.draw({}, { zoom: 1 }, null)).toBe(false);
  });
});
