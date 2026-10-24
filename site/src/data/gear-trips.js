// Gear history as trips, the hub's rule (hub D-121, @hub/core gear-trips.ts) on the map's equipment
// arrays: the change log grouped into the stretches of play one kit is worn for, so a PvM trip of
// swaps reads as one entry with the gear brought for it instead of a row per swap.
//
// A trip is a run of changes where each comes less than TRIP_GAP_MS after the one before it and
// each set worn has at least TRIP_MIN_SHARED items in common with what the trip has used so far. A
// set with nothing on belongs to the trip it ends. Keep this in step with the hub's copy.

export const TRIP_GAP_MS = 20 * 60_000;

export const TRIP_MIN_SHARED = 2;

// Equipment array slot indexes (id/quantity pairs, server/src/osrs.rs) in the game's order:
// head, cape, neck, ammo, weapon, body, shield, legs, hands, feet, ring.
export const SLOT_ORDER = [0, 1, 2, 13, 3, 4, 5, 7, 9, 10, 12];

/** slot index → [id, quantity] of a flat equipment array. */
function slotMap(equipment) {
  const out = new Map();
  if (!Array.isArray(equipment)) return out;
  for (let i = 0; i + 1 < equipment.length; i += 2) {
    const id = equipment[i];
    if (Number.isInteger(id) && id > 0) out.set(i / 2, [id, equipment[i + 1]]);
  }
  return out;
}

function sharedCount(set, ids) {
  let n = 0;
  for (const [id] of set.values()) if (ids.has(id)) n += 1;
  return n;
}

function setKey(set) {
  return [...set.entries()]
    .map(([slot, [id]]) => `${slot}:${id}`)
    .sort()
    .join(",");
}

function slotRank(slot) {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length + slot : i;
}

function openTrip(changedAt) {
  return {
    startedAt: changedAt,
    endedAt: changedAt,
    swaps: 0,
    ids: new Set(),
    setups: new Set(),
    worn: new Map(),
    seen: 0,
  };
}

function wear(trip, set, ms) {
  if (set.size === 0) return;
  trip.setups.add(setKey(set));
  for (const [slot, [id, quantity]] of set) {
    trip.ids.add(id);
    if (!trip.worn.has(slot)) trip.worn.set(slot, new Map());
    const bySlot = trip.worn.get(slot);
    const entry = bySlot.get(id);
    if (entry) entry.ms += ms;
    else bySlot.set(id, { id, quantity, ms, order: trip.seen++ });
  }
}

function close(trip) {
  const kit = [...trip.worn.entries()]
    .sort(([a], [b]) => slotRank(a) - slotRank(b))
    .map(([slot, items]) => ({
      slot,
      items: [...items.values()]
        .sort((a, b) => b.ms - a.ms || a.order - b.order)
        .map(({ id, quantity }) => ({ id, quantity })),
    }));
  return { startedAt: trip.startedAt, endedAt: trip.endedAt, swaps: trip.swaps, setups: trip.setups.size, kit };
}

/**
 * The map's gear history (`{ changed_at, equipment }`, any order) as trips, newest first:
 * `{ startedAt, endedAt, swaps, setups, kit: [{ slot, items: [{ id, quantity }] }] }`, a kit slot's
 * items the longest worn first. `now` closes the time the last set was worn.
 */
export function gearTrips(changes, now = Date.now()) {
  const rows = (Array.isArray(changes) ? changes : [])
    .map((c) => ({ at: Date.parse(c?.changed_at), changedAt: c?.changed_at, set: slotMap(c?.equipment) }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
  const trips = [];
  let trip = null;
  let previous = null;

  rows.forEach((row, i) => {
    const nextAt = i + 1 < rows.length ? rows[i + 1].at : now;
    const ms = Math.max(0, Math.min(nextAt - row.at, TRIP_GAP_MS));
    const afterGap = previous !== null && row.at - previous.at >= TRIP_GAP_MS;
    if (afterGap && row.set.size === 0) {
      // Everything taken off long after the last swap: the trip had ended already.
      previous = row;
      return;
    }
    const newOutfit =
      trip !== null &&
      trip.ids.size > 0 &&
      row.set.size > TRIP_MIN_SHARED &&
      sharedCount(row.set, trip.ids) < TRIP_MIN_SHARED;

    if (trip === null || afterGap || newOutfit) {
      if (trip !== null) trips.push(close(trip));
      trip = openTrip(row.changedAt);
      // A swap from the set worn before the trip: that set came along, so it is part of the kit.
      const before = new Set([...(previous?.set.values() ?? [])].map(([id]) => id));
      if (before.size > 0 && row.set.size > 0 && sharedCount(row.set, before) >= TRIP_MIN_SHARED) {
        wear(trip, previous.set, 0);
        trip.swaps = 1;
      }
    } else {
      trip.swaps += 1;
      trip.endedAt = row.changedAt;
    }
    wear(trip, row.set, ms);
    previous = row;
  });
  if (trip !== null) trips.push(close(trip));
  return trips.reverse();
}
