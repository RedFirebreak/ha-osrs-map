import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/data/api";
import { pubsub } from "../src/data/pubsub";
import { selection } from "../src/data/selection";
import { colorForName } from "../src/data/player-colors";
import "../src/map-page/map-page";

const NOW_S = 1_790_000_000;

/** What the map page needs of the map: it records which trails are drawn. */
function fakeWorldMap() {
  const map = document.createElement("div");
  map.id = "background-worldmap";
  const drawn = new Set();
  Object.assign(map, {
    plane: 1,
    setTrail: vi.fn((name) => drawn.add(name)),
    clearTrail: vi.fn((name) => drawn.delete(name)),
    clearTrails: vi.fn(() => drawn.clear()),
    trailNames: () => [...drawn],
    setTrailEvents: vi.fn(),
    setEventFilters: vi.fn(),
    goToEvent: vi.fn(),
    setReplayTime: vi.fn(),
    trailNextChange: vi.fn(() => null),
    trailNextHop: vi.fn(() => null),
    // As the real map: nothing to replay until a trail is drawn.
    trailTimeline: () =>
      drawn.size ? { tMin: NOW_S - 3600, tMax: NOW_S, ticks: [] } : { tMin: null, tMax: null, ticks: [] },
  });
  return map;
}

function trailsResponse(names, extra = {}) {
  return {
    v: 2,
    days: 1,
    as_of: NOW_S,
    trails: names.map((member) => ({ member, shared: true, step: 60, points: [[3200, 3200, 0, NOW_S - 60]] })),
    ...extra,
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("map page trails", () => {
  let worldMap, page;

  function mount() {
    page = document.createElement("map-page");
    document.body.appendChild(page);
    return page;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_S * 1000);
    selection.reset();
    const authed = document.createElement("div");
    authed.className = "authed-section";
    worldMap = fakeWorldMap();
    document.body.append(authed, worldMap);
    pubsub.publish("features", { hub_history: true });
    vi.spyOn(api, "getTrailEvents").mockResolvedValue([]);
    vi.spyOn(api, "getPlayerSessions").mockResolvedValue({ sessions: [], total_ms: 0 });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // The page calls into these as soon as it is connected, which in the bundle
  // is the moment it is defined: they have to be defined before it.
  it("loads the components it drives", () => {
    expect(customElements.get("trail-scrubber")).toBeDefined();
    expect(customElements.get("canvas-map")).toBeDefined();
  });

  it("draws nothing when the trails are cleared while their request is under way", async () => {
    const request = deferred();
    vi.spyOn(api, "getTrails").mockReturnValue(request.promise);
    mount();
    selection.toggleTrail("Alice");
    selection.clearTrails();
    request.resolve(trailsResponse(["Alice"]));
    await settle();
    expect(worldMap.setTrail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes a trail off the map as soon as it is switched off", async () => {
    vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice", "Bob"]));
    mount();
    selection.toggleTrail("Alice");
    selection.toggleTrail("Bob");
    await settle();
    expect(worldMap.trailNames().sort()).toEqual(["Alice", "Bob"]);

    api.getTrails.mockReturnValue(deferred().promise);
    selection.toggleTrail("Bob");
    expect(worldMap.trailNames()).toEqual(["Alice"]);
  });

  it("keeps the drawn trails and says so when a refresh fails", async () => {
    vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
    mount();
    selection.toggleTrail("Alice");
    await settle();

    api.getTrails.mockRejectedValue(Object.assign(new Error("busy"), { status: 503 }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(worldMap.trailNames()).toEqual(["Alice"]);
    expect(page.querySelector(".map-page__trail-error").textContent).toBe("Hub busy");
  });

  it("tries again sooner after a failure than after a success", async () => {
    vi.spyOn(api, "getTrails").mockRejectedValue(new Error("down"));
    mount();
    selection.toggleTrail("Alice");
    await settle();
    expect(api.getTrails).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.getTrails).toHaveBeenCalledTimes(2);

    api.getTrails.mockResolvedValue(trailsResponse(["Alice"]));
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getTrails).toHaveBeenCalledTimes(3);
    expect(page.querySelector(".map-page__trail-error")).toBeNull();
    await vi.advanceTimersByTimeAsync(59000);
    expect(api.getTrails).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.getTrails).toHaveBeenCalledTimes(4);
  });

  it("says when the hub's data is old", async () => {
    vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"], { as_of: NOW_S - 600 }));
    mount();
    selection.toggleTrail("Alice");
    await settle();
    expect(page.querySelector(".map-page__trail-error").textContent).toMatch(/^Hub data from \d/);
  });

  it("hands the map each shared trail with the player's colours and how far back it goes", async () => {
    const response = trailsResponse(["Alice"]);
    response.trails.push({ member: "Bob", shared: false });
    vi.spyOn(api, "getTrails").mockResolvedValue(response);
    mount();
    selection.toggleTrail("Alice");
    selection.toggleTrail("Bob");
    await settle();
    const { color, light } = colorForName("Alice");
    expect(worldMap.setTrail).toHaveBeenCalledTimes(1);
    expect(worldMap.setTrail).toHaveBeenCalledWith("Alice", response.trails[0], {
      color,
      light,
      windowS: 86400,
      until: null,
    });
    expect(page.querySelector('[data-name="Bob"]').textContent).toContain("not shared");
  });

  it("doesn't ask for trails while the server has the hub's history switched off", async () => {
    vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
    pubsub.publish("features", { hub_history: false });
    mount();
    selection.toggleTrail("Alice");
    await vi.advanceTimersByTimeAsync(120000);
    expect(api.getTrails).not.toHaveBeenCalled();

    pubsub.publish("features", { hub_history: true });
    await settle();
    expect(api.getTrails).toHaveBeenCalledTimes(1);
    expect(worldMap.trailNames()).toEqual(["Alice"]);
  });

  it("says from when a trail runs that was too long to show whole", async () => {
    const response = trailsResponse(["Alice", "Bob"]);
    response.trails[0].truncated = true;
    response.trails[0].points = [
      [3200, 3200, 0, NOW_S - 5 * 86400],
      [3201, 3200, 0, NOW_S - 60],
    ];
    vi.spyOn(api, "getTrails").mockResolvedValue(response);
    mount();
    selection.toggleTrail("Alice");
    selection.toggleTrail("Bob");
    await settle();
    const since = new Date((NOW_S - 5 * 86400) * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
    expect(page.querySelector('[data-name="Alice"]').textContent).toBe(`Alice (since ${since})`);
    expect(page.querySelector('[data-name="Bob"]').textContent).toBe("Bob");
  });

  it("says the time of day too when that trail starts within the last two days", async () => {
    const response = trailsResponse(["Alice"]);
    response.trails[0].truncated = true;
    // On the tile from 26 to 25 hours ago: the trail starts when they got there.
    response.trails[0].points = [
      [3200, 3200, 0, NOW_S - 25 * 3600, 3600],
      [3201, 3200, 0, NOW_S - 60],
    ];
    vi.spyOn(api, "getTrails").mockResolvedValue(response);
    mount();
    selection.toggleTrail("Alice");
    await settle();
    const start = new Date((NOW_S - 26 * 3600) * 1000);
    const day = start.toLocaleDateString([], { day: "numeric", month: "short" });
    const time = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(page.querySelector('[data-name="Alice"]').textContent).toBe(`Alice (since ${day} ${time})`);
  });

  describe("events", () => {
    const event = (id, member, secondsAgo, extra = {}) => ({
      id,
      type: "death",
      member,
      occurred_at: new Date((NOW_S - secondsAgo) * 1000).toISOString(),
      location: { x: 3142, y: 9958, plane: 0 },
      ...extra,
    });
    /** The events last handed to the map for a player's trail. */
    const marked = (name) => {
      const calls = worldMap.setTrailEvents.mock.calls;
      return (calls[calls.length - 1][0].get(name) || []).map((e) => e.id);
    };

    beforeEach(() => {
      vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
      api.getTrailEvents.mockResolvedValue([event("a", "Alice", 300), event("l", "Alice", 200, { type: "level_up" })]);
    });

    it("of the players whose trails are shown are handed to the map", async () => {
      mount();
      selection.toggleTrail("Alice");
      await settle();
      // Over the length of the trail, and no smaller drops than the map shows.
      expect(api.getTrailEvents).toHaveBeenCalledWith("Alice", 1, 100000);
      expect(marked("Alice")).toEqual(["a", "l"]);
    });

    it("include what the live feed has of that player, once", async () => {
      const live = [event("a", "Alice", 300), event("recent", "Alice", 20), event("bob", "Bob", 10)];
      pubsub.publish("live-events", { events: live, added: [], initial: true });
      mount();
      selection.toggleTrail("Alice");
      await settle();
      expect(marked("Alice")).toEqual(["a", "l", "recent"]);
    });

    it("include one that happens while the map is open", async () => {
      mount();
      selection.toggleTrail("Alice");
      await settle();
      const added = [event("c", "Alice", 0)];
      pubsub.publish("live-events", { events: added, added, initial: false });
      expect(marked("Alice")).toEqual(["a", "l", "c"]);
    });

    it("aren't asked for again with every refresh of the trails, only now and then", async () => {
      mount();
      selection.toggleTrail("Alice");
      await settle();
      expect(api.getTrailEvents).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60000);
      expect(api.getTrails.mock.calls.length).toBeGreaterThan(3);
      expect(api.getTrailEvents).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6 * 60000);
      expect(api.getTrailEvents).toHaveBeenCalledTimes(2);
    });

    it("are asked for again when the trails get longer", async () => {
      mount();
      selection.toggleTrail("Alice");
      await settle();
      const select = page.querySelector(".map-page__trail-days");
      select.value = "7";
      select.dispatchEvent(new Event("change"));
      await settle();
      expect(api.getTrailEvents).toHaveBeenCalledTimes(2);
      expect(api.getTrailEvents).toHaveBeenLastCalledWith("Alice", 7, 100000);
    });

    it("are asked for again when smaller drops are to be shown, not when only bigger ones are", async () => {
      mount();
      selection.toggleTrail("Alice");
      await settle();
      const minLoot = page.querySelector(".map-page__event-min-loot");
      const choose = async (value) => {
        minLoot.value = value;
        minLoot.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
      };

      await choose("10000000");
      expect(api.getTrailEvents).toHaveBeenCalledTimes(1);
      await choose("0");
      expect(api.getTrailEvents).toHaveBeenCalledTimes(2);
      expect(api.getTrailEvents).toHaveBeenLastCalledWith("Alice", 1, 0);
      // What was fetched with every drop in it serves any filter.
      await choose("1000000");
      expect(api.getTrailEvents).toHaveBeenCalledTimes(2);
    });

    it("are asked for again for a trail that was switched off and on", async () => {
      mount();
      selection.toggleTrail("Alice");
      await settle();
      selection.toggleTrail("Alice");
      selection.toggleTrail("Alice");
      await settle();
      expect(api.getTrailEvents).toHaveBeenCalledTimes(2);
    });

    it("don't hold up the trails when they can't be fetched", async () => {
      api.getTrailEvents.mockRejectedValue(Object.assign(new Error("not shared"), { status: 404 }));
      const live = [event("recent", "Alice", 20)];
      pubsub.publish("live-events", { events: live, added: [], initial: true });
      mount();
      selection.toggleTrail("Alice");
      await settle();
      expect(worldMap.trailNames()).toEqual(["Alice"]);
      expect(page.querySelector(".map-page__trail-error")).toBeNull();
      expect(marked("Alice")).toEqual(["recent"]);
    });

    it("are asked for again with the next refresh when the hub was busy, not when they aren't shared", async () => {
      api.getTrailEvents.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503 }));
      mount();
      selection.toggleTrail("Alice");
      await settle();
      expect(api.getTrailEvents).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(api.getTrailEvents).toHaveBeenCalledTimes(2);
      expect(marked("Alice")).toEqual(["a", "l"]);

      api.getTrailEvents.mockClear();
      api.getTrailEvents.mockRejectedValue(Object.assign(new Error("not shared"), { status: 404 }));
      selection.toggleTrail("Alice");
      selection.toggleTrail("Alice");
      await settle();
      await vi.advanceTimersByTimeAsync(5 * 60000);
      expect(api.getTrailEvents).toHaveBeenCalledTimes(1);
    });

    it("leave the filtering to the map, which is told the filters", async () => {
      localStorage.setItem("map-event-filters", JSON.stringify({ death: false }));
      mount();
      expect(worldMap.setEventFilters).toHaveBeenLastCalledWith(expect.objectContaining({ death: false }));
      const toggle = page.querySelector('.map-page__event-kinds input[name="death"]');
      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      expect(worldMap.setEventFilters).toHaveBeenLastCalledWith(expect.objectContaining({ death: true }));
    });
  });

  describe("toasts", () => {
    const drop = (id, secondsAgo, extra = {}) => ({
      id,
      type: "loot",
      member: "Alice",
      line: `Alice received drop ${id}`,
      value_gp: 2500000,
      occurred_at: new Date((NOW_S - secondsAgo) * 1000).toISOString(),
      ...extra,
    });
    const arrive = (...added) => pubsub.publish("live-events", { events: added, added, initial: false });
    /** The page with the live feed already under way, as when the map is opened later on. */
    const mountLive = () => {
      pubsub.publish("live-events", { events: [], added: [], initial: true });
      return mount();
    };
    const shown = () => [...page.querySelectorAll(".event-toasts__text")].map((text) => text.textContent);

    it("announce what happens while the map is open", () => {
      mountLive();
      arrive(drop("a", 5));
      expect(shown()).toEqual(["Alice received drop a"]);
    });

    it("leave out what the filters hide", () => {
      mountLive();
      arrive(drop("small", 5, { value_gp: 500 }), { ...drop("level", 5), type: "level_up" });
      expect(shown()).toEqual(["Alice received drop level"]);
    });

    it("leave out what happened a while ago", () => {
      mountLive();
      arrive(drop("old", 600));
      expect(shown()).toEqual([]);
    });

    it("can be switched off, which is remembered", () => {
      mountLive();
      const toggle = page.querySelector('.map-page__events input[name="toasts"]');
      expect(toggle.checked).toBe(true);
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      arrive(drop("a", 5));
      expect(shown()).toEqual([]);

      page.remove();
      mountLive();
      expect(page.querySelector('.map-page__events input[name="toasts"]').checked).toBe(false);
    });

    it("show the map where it happened when clicked", () => {
      mountLive();
      arrive(drop("d", 5));
      page.querySelector(".event-toasts__toast").click();
      expect(worldMap.goToEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "d" }));
      expect(shown()).toEqual([]);
    });

    it("start no timer until there is something to show", () => {
      mountLive();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("replay", () => {
    const replayButton = () => page.querySelector(".map-page__trails-replay");
    const scrubber = () => page.querySelector("trail-scrubber");

    beforeEach(async () => {
      vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
      mount();
      selection.toggleTrail("Alice");
      await settle();
      worldMap.dispatchEvent(new CustomEvent("trail-timeline-changed"));
    });

    it("is closed to begin with", () => {
      expect(scrubber().hidden).toBe(true);
      expect(replayButton().getAttribute("aria-pressed")).toBe("false");
      expect(worldMap.setReplayTime).not.toHaveBeenCalled();
    });

    it("shows the map at the time of the timeline, and live again when closed", () => {
      replayButton().click();
      expect(scrubber().hidden).toBe(false);
      expect(replayButton().getAttribute("aria-pressed")).toBe("true");
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(NOW_S, { follow: false, hop: null });

      scrubber().seek(NOW_S - 600);
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(NOW_S - 600, { follow: true, hop: null });

      replayButton().click();
      expect(scrubber().hidden).toBe(true);
      expect(replayButton().getAttribute("aria-pressed")).toBe("false");
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(null, { follow: false, hop: null });
    });

    it("stops following the player once the map is dragged", () => {
      replayButton().click();
      worldMap.dispatchEvent(new CustomEvent("map-dragged"));
      expect(scrubber().querySelector(".trail-scrubber__follow input").checked).toBe(false);
      scrubber().seek(NOW_S - 600);
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(NOW_S - 600, { follow: false, hop: null });
    });

    it("closes when the last trail is switched off", () => {
      replayButton().click();
      selection.clearTrails();
      worldMap.dispatchEvent(new CustomEvent("trail-timeline-changed"));
      expect(scrubber().hidden).toBe(true);
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(null, { follow: false, hop: null });
    });

    it("asks the map what happens next on the trails", () => {
      scrubber().nextChange(NOW_S - 100);
      expect(worldMap.trailNextChange).toHaveBeenCalledWith(NOW_S - 100);
    });

    it("asks the map where the player hops next, to stop the replay for it", () => {
      scrubber().nextHop(NOW_S - 100, NOW_S - 70);
      expect(worldMap.trailNextHop).toHaveBeenCalledWith(NOW_S - 100, NOW_S - 70);
    });

    it("passes on how far a teleport that is played out has got", () => {
      const hop = { leave: NOW_S - 600, land: NOW_S - 598, progress: 0.4 };
      scrubber().dispatchEvent(new CustomEvent("replay-change", { detail: { time: NOW_S - 600, follow: true, hop } }));
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(NOW_S - 600, { follow: true, hop });
    });

    it("keeps the speed that was picked when the length of the trails changes", async () => {
      const speed = scrubber().querySelector(".trail-scrubber__speed");
      expect(speed.value).toBe("300");
      speed.value = "120";
      speed.dispatchEvent(new Event("change", { bubbles: true }));
      const select = page.querySelector(".map-page__trail-days");
      select.value = "7";
      select.dispatchEvent(new Event("change"));
      await settle();
      expect(scrubber().clock.speed).toBe(120);
      expect(speed.value).toBe("120");
    });

    it("leaves the map live when the page is left", () => {
      replayButton().click();
      page.remove();
      expect(worldMap.setReplayTime).toHaveBeenLastCalledWith(null);
    });
  });

  it("draws the line for that at two days", async () => {
    const chip = async (hoursAgo) => {
      const response = trailsResponse(["Alice"]);
      response.trails[0].truncated = true;
      response.trails[0].points = [
        [3200, 3200, 0, NOW_S - hoursAgo * 3600],
        [3201, 3200, 0, NOW_S - 60],
      ];
      vi.spyOn(api, "getTrails").mockResolvedValue(response);
      mount();
      selection.toggleTrail("Alice");
      await settle();
      const text = page.querySelector('[data-name="Alice"]').textContent;
      page.remove();
      selection.reset();
      return text;
    };
    const start = (hoursAgo) => new Date((NOW_S - hoursAgo * 3600) * 1000);
    const day = (date) => date.toLocaleDateString([], { day: "numeric", month: "short" });
    const time = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(await chip(47)).toBe(`Alice (since ${day(start(47))} ${time(start(47))})`);
    expect(await chip(49)).toBe(`Alice (since ${day(start(49))})`);
  });

  describe("a play session", () => {
    const START = NOW_S - 5 * 3600;
    const END = NOW_S - 3 * 3600;
    const iso = (seconds) => new Date(seconds * 1000).toISOString();
    const over = { started_at: iso(START), ended_at: iso(END), last_seen_at: iso(END), duration_ms: 7200000 };
    const open = { started_at: iso(NOW_S - 1800), ended_at: null, last_seen_at: iso(NOW_S), duration_ms: 1800000 };
    const select = () => page.querySelector(".map-page__trail-days");
    const sessionOptions = () => [...select().querySelectorAll("optgroup option")];

    async function shown(names, sessions = [open, over]) {
      api.getPlayerSessions.mockResolvedValue({ sessions, total_ms: 0 });
      vi.spyOn(api, "getTrails").mockImplementation(async (members) => trailsResponse(members));
      mount();
      for (const name of names) selection.toggleTrail(name);
      await settle();
    }

    async function pick(index) {
      select().value = sessionOptions()[index].value;
      select().dispatchEvent(new Event("change"));
      await settle();
    }

    afterEach(() => {
      pubsub.publish("player-selected", null);
    });

    it("lists the sessions of the first trail's player below the lengths", async () => {
      await shown(["Alice", "Bob"]);
      expect(api.getPlayerSessions).toHaveBeenCalledWith("Alice", 7);
      expect(select().querySelector("optgroup").label).toBe("Sessions of Alice");
      expect(sessionOptions()).toHaveLength(2);
      expect(sessionOptions()[0].textContent).toMatch(/^Now, since /);
      expect([...select().options].slice(0, 2).map((option) => option.value)).toEqual(["1", "7"]);
      expect(select().value).toBe("1");
    });

    it("lists those of the selected player when their trail is on", async () => {
      await shown(["Alice", "Bob"]);
      selection.select("Bob");
      await settle();
      expect(api.getPlayerSessions).toHaveBeenLastCalledWith("Bob", 7);
      expect(select().querySelector("optgroup").label).toBe("Sessions of Bob");
    });

    it("shows every trail over the session that was picked, a minute to either side", async () => {
      await shown(["Alice", "Bob"]);
      await pick(1);
      const span = { from: START - 60, to: END + 60 };
      expect(api.getTrails).toHaveBeenLastCalledWith(["Alice", "Bob"], span);
      expect(api.getTrailEvents).toHaveBeenLastCalledWith("Bob", span, 100000);
      // Drawn as a trail that ended then, as long as the session was.
      const style = worldMap.setTrail.mock.calls.at(-1)[2];
      expect(style).toMatchObject({ windowS: END - START + 120, until: END + 60 });
    });

    it("shows a session that is still going on until now", async () => {
      await shown(["Alice"]);
      await pick(0);
      expect(api.getTrails).toHaveBeenLastCalledWith(["Alice"], { from: NOW_S - 1800 - 60, to: null });
      const style = worldMap.setTrail.mock.calls.at(-1)[2];
      expect(style).toMatchObject({ windowS: 1860, until: null });
    });

    it("does not remember a session as the length of the trails", async () => {
      await shown(["Alice"]);
      await pick(1);
      expect(JSON.parse(localStorage.getItem("map-trail-days") || '"1"')).toBe("1");
    });

    it("keeps the session that was picked while another player is selected", async () => {
      await shown(["Alice", "Bob"]);
      await pick(1);
      selection.select("Bob");
      await settle();
      expect(select().querySelector("optgroup").label).toBe("Sessions of Alice");
      expect(api.getTrails).toHaveBeenLastCalledWith(["Alice", "Bob"], { from: START - 60, to: END + 60 });
    });

    it("goes back to the length it remembers when the session's player is taken off", async () => {
      await shown(["Alice", "Bob"]);
      await pick(1);
      selection.toggleTrail("Alice");
      await settle();
      expect(select().value).toBe("1");
      expect(api.getTrails).toHaveBeenLastCalledWith(["Bob"], 1);
      expect(select().querySelector("optgroup").label).toBe("Sessions of Bob");
    });

    it("follows a session that ends while it is shown", async () => {
      await shown(["Alice"]);
      await pick(0);
      const ended = { ...open, ended_at: iso(NOW_S + 30), last_seen_at: iso(NOW_S + 30) };
      api.getPlayerSessions.mockResolvedValue({ sessions: [ended, over], total_ms: 0 });
      await vi.advanceTimersByTimeAsync(61000);
      await settle();
      expect(api.getTrails).toHaveBeenLastCalledWith(["Alice"], { from: NOW_S - 1800 - 60, to: NOW_S + 30 + 60 });
    });

    it("has no sessions to offer when the player doesn't share them", async () => {
      api.getPlayerSessions.mockRejectedValue(Object.assign(new Error("not shared"), { status: 404 }));
      vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
      mount();
      selection.toggleTrail("Alice");
      await settle();
      expect(select().querySelector("optgroup")).toBeNull();
      expect(worldMap.trailNames()).toEqual(["Alice"]);
    });
  });

  it("offers 24 hours and 7 days", () => {
    mount();
    const select = page.querySelector(".map-page__trail-days");
    expect([...select.options].map((option) => option.value)).toEqual(["1", "7"]);
    expect(select.value).toBe("1");
  });

  it("goes back to 24 hours when the length it remembers is no longer offered", async () => {
    localStorage.setItem("map-trail-days", JSON.stringify("30"));
    vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
    mount();
    selection.toggleTrail("Alice");
    await settle();
    expect(page.querySelector(".map-page__trail-days").value).toBe("1");
    expect(api.getTrails).toHaveBeenLastCalledWith(["Alice"], 1);
  });

  it("remembers the trail length", async () => {
    vi.spyOn(api, "getTrails").mockResolvedValue(trailsResponse(["Alice"]));
    mount();
    selection.toggleTrail("Alice");
    await settle();
    const select = page.querySelector(".map-page__trail-days");
    select.value = "7";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(api.getTrails).toHaveBeenLastCalledWith(["Alice"], 7);

    page.remove();
    mount();
    await settle();
    expect(page.querySelector(".map-page__trail-days").value).toBe("7");
    expect(api.getTrails).toHaveBeenLastCalledWith(["Alice"], 7);
  });
});
