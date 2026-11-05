import { describe, expect, it } from "vitest";
import { effectTitle, effectsElement, formatLeft, statusElement, statusState } from "../src/data/status";

const NOW = Date.parse("2026-11-05T21:00:00Z");
const meta = {
  status: {
    run_energy: 73,
    running: true,
    special_attack: 50,
    poison: { type: "venom", damage: 8 },
    wilderness_level: 23,
    effects: [
      { id: "stamina", name: "Stamina", ends_at: new Date(NOW + 65_000).toISOString(), precision_ms: 6000 },
      { id: "teleblock", name: "Teleblock", ends_at: new Date(NOW + 5_000).toISOString(), precision_ms: 600 },
    ],
  },
};

describe("statusState", () => {
  it("reads what the hub sends", () => {
    const state = statusState({ meta });
    expect(state.runEnergy).toBe(73);
    expect(state.poison).toEqual({ type: "venom", damage: 8 });
    expect(state.wildernessLevel).toBe(23);
    expect(state.effects.map((e) => e.id)).toEqual(["stamina", "teleblock"]);
    expect(state.effects[0].endsAt).toBe(NOW + 65_000);
  });

  it("is null when the hub doesn't say", () => {
    expect(statusState({ meta: {} })).toBeNull();
    expect(statusState({ meta: { status: { run_energy: 500, special_attack: 0 } } })).toBeNull();
  });

  it("reads an unknown poison type as none, and drops an effect without an end", () => {
    const state = statusState({
      meta: { status: { run_energy: 1, special_attack: 2, poison: { type: "acid" }, effects: [{ id: "x" }] } },
    });
    expect(state.poison).toEqual({ type: "none", damage: null });
    expect(state.effects).toEqual([]);
  });
});

describe("formatLeft", () => {
  it("counts down, never below zero", () => {
    expect(formatLeft(NOW + 245_000, NOW)).toBe("4:05");
    expect(formatLeft(NOW + 3_723_000, NOW)).toBe("1:02:03");
    expect(formatLeft(NOW - 1, NOW)).toBe("0:00");
  });
});

describe("status elements", () => {
  it("draws two orbs and the badges", () => {
    const box = statusElement(statusState({ meta }));
    expect([...box.querySelectorAll(".status-orb__label")].map((e) => e.textContent)).toEqual(["Run", "Special"]);
    expect(box.querySelector(".status__badge--venom").textContent).toBe("Venomed · 8");
    expect(box.querySelector(".status__badge--wilderness").textContent).toBe("Wilderness level 23");
  });

  it("counts the cards down and drops the ones that ended", () => {
    const state = statusState({ meta });
    const { list, tick } = effectsElement(state, NOW);
    expect([...list.querySelectorAll(".status__effect-left")].map((e) => e.textContent)).toEqual(["1:05", "0:05"]);
    expect(list.children[0].title).toBe(effectTitle(state.effects[0], NOW));
    expect(list.children[0].title.split("\n")[0]).toBe("Stamina");
    expect(tick(NOW + 10_000)).toBe(1);
    expect(list.children).toHaveLength(1);
    expect(list.querySelector(".status__effect-left").textContent).toBe("0:55");
  });
});
