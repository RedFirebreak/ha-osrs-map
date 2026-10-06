import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/data/api";
import { pubsub } from "../src/data/pubsub";
import "../src/event-feed/event-feed";

describe("a player's event feed", () => {
  const death = (id, location) => ({
    id,
    type: "death",
    member: "Alice",
    line: `Alice died (${id})`,
    occurred_at: "2026-10-01T12:00:00Z",
    location,
  });
  const CLICKABLE = "event-feed__event--clickable";

  let feed;

  /** The feed in a player's profile, once it has the player's events. */
  async function mount(events) {
    vi.spyOn(api, "getPlayerEvents").mockResolvedValue(events);
    feed = document.createElement("event-feed");
    feed.setAttribute("player-name", "Alice");
    document.body.appendChild(feed);
    await vi.waitFor(() => expect(feed.querySelectorAll(".event-feed__event")).toHaveLength(events.length));
  }

  const row = (id) => feed.querySelector(`[data-id="${id}"]`);

  /** What the map is asked to show from here on. */
  function focused() {
    const places = [];
    pubsub.subscribe("map-focus", (place) => places.push(place), false);
    return places;
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows on the map where an event says it happened, when clicked", async () => {
    await mount([death("surface", { x: 3200, y: 3200, plane: 1 }), death("nowhere", null)]);
    expect(row("surface").classList.contains(CLICKABLE)).toBe(true);
    expect(row("nowhere").classList.contains(CLICKABLE)).toBe(false);
    const places = focused();
    row("nowhere").click();
    expect(places).toEqual([]);
    row("surface").click();
    expect(places).toEqual([{ x: 3200, y: 3201, plane: 1, zoom: undefined }]);
  });

  it("has nowhere to show for an event that says it happened inside an instance", async () => {
    // The instance's own coordinates, as the plugin sends them for a death in a raid.
    await mount([death("raid", { x: 12850, y: 4500, plane: 0 })]);
    expect(row("raid").classList.contains(CLICKABLE)).toBe(false);
    const places = focused();
    row("raid").click();
    expect(places).toEqual([]);
  });
});
