import { describe, expect, it } from "vitest";
import { gearTrips, TRIP_GAP_MS } from "../src/data/gear-trips";

// Flat equipment arrays as the map's backend sends them: [id, quantity] per slot index
// (0 head, 1 cape, 2 neck, 3 weapon, 4 body, 7 legs, 9 hands, 10 feet, 12 ring, 13 ammo).
function equipment(bySlot) {
  const flat = new Array(28).fill(0);
  for (const [slot, id] of Object.entries(bySlot)) {
    flat[slot * 2] = id;
    flat[slot * 2 + 1] = 1;
  }
  return flat;
}

const BASE = { 1: 28955, 9: 26235, 10: 13239, 12: 25975 };
const MELEE = equipment({ ...BASE, 0: 26382, 2: 24780, 3: 22325, 4: 26384, 7: 26386 });
const RANGED = equipment({ ...BASE, 0: 27235, 2: 19547, 3: 12926, 4: 27238, 7: 27241 });
const FISHING = equipment({ 0: 13258, 3: 21028, 4: 13259, 7: 13260, 12: 25975 });

const T0 = Date.parse("2026-10-24T12:00:00Z");
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const change = (minutes, eq) => ({ changed_at: at(minutes), equipment: eq });
const ids = (slot) => slot.items.map((item) => item.id);

describe("gearTrips", () => {
  it("is empty for nothing", () => {
    expect(gearTrips(undefined)).toEqual([]);
    expect(gearTrips([])).toEqual([]);
  });

  it("folds melee/ranged switches and back into one trip with the kit brought", () => {
    const log = [change(0, MELEE), change(1, RANGED), change(2, MELEE), change(3, RANGED), change(5, MELEE)];
    const trips = gearTrips(log.reverse(), T0 + 6 * 60_000);
    expect(trips).toHaveLength(1);
    const [trip] = trips;
    expect(trip.startedAt).toBe(at(0));
    expect(trip.endedAt).toBe(at(5));
    expect(trip.swaps).toBe(4);
    expect(trip.setups).toBe(2);
    // The game's order: head, cape, neck, weapon, body, legs, hands, feet, ring.
    expect(trip.kit.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 7, 9, 10, 12]);
    expect(ids(trip.kit[0])).toEqual([26382, 27235]);
    expect(ids(trip.kit[1])).toEqual([28955]);
  });

  it("starts a new trip after a pause, carrying the set worn before a swap", () => {
    const trips = gearTrips([change(0, MELEE), change(1, RANGED), change(60, MELEE)]);
    expect(trips).toHaveLength(2);
    expect(trips[0].startedAt).toBe(at(60));
    expect(trips[0].swaps).toBe(1);
    expect(ids(trips[0].kit[0])).toContain(27235);
  });

  it("starts a new trip for a different outfit without a pause", () => {
    const trips = gearTrips([change(0, MELEE), change(2, RANGED), change(5, FISHING)]);
    expect(trips).toHaveLength(2);
    expect(trips[0].swaps).toBe(0);
    expect(trips[1].setups).toBe(2);
  });

  it("keeps taking everything off in the trip, and ignores it long after", () => {
    const empty = equipment({});
    expect(gearTrips([change(0, MELEE), change(1, empty)])[0].endedAt).toBe(at(1));
    const later = gearTrips([change(0, MELEE), change(1, RANGED), change(90, empty)]);
    expect(later).toHaveLength(1);
    expect(later[0].endedAt).toBe(at(1));
    expect(TRIP_GAP_MS).toBe(20 * 60_000);
  });
});
