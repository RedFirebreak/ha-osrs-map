import { beforeEach, describe, expect, it } from "vitest";
import { MemberData } from "../src/data/member-data";
import { Item } from "../src/data/item";
import { pubsub } from "../src/data/pubsub";

describe("member-data", () => {
  beforeEach(() => {
    Item.itemDetails = {
      4151: { id: 4151, name: "Abyssal whip" },
    };
  });

  it("parses inventory and equipment and publishes them on their own topics", () => {
    const member = new MemberData("Alice");

    const updated = member.update({
      inventory: [{ id: 4151, quantity: 2 }],
      equipment: [{ id: 4151, quantity: 1 }],
    });

    expect(updated.has("inventory")).toBe(true);
    expect(updated.has("equipment")).toBe(true);
    expect(member.itemQuantities.inventory.get(4151)).toBe(2);
    expect(member.itemQuantities.equipment.get(4151)).toBe(1);
    expect(pubsub.getMostRecent("inventory:Alice")[0][0].id).toBe(4151);
  });

  it("leaves nothing of a dropped section for a component that subscribes later", () => {
    const member = new MemberData("Alice");
    member.update({
      stats: { hitpoints: { current: 50, max: 99 }, prayer: { current: 1, max: 70 }, world: 328 },
      skills: { Attack: 13034431, Overall: 13034431 },
      inventory: [{ id: 4151, quantity: 2 }],
      equipment: [{ id: 4151, quantity: 1 }],
    });
    expect(pubsub.getMostRecent("Attack:Alice")[0].xp).toBe(13034431);

    const updated = member.update({ stats: null, skills: null, inventory: null, equipment: null });

    expect([...updated].sort()).toEqual(["equipment", "inventory", "skills", "stats"]);
    for (const topic of ["stats", "inventory", "equipment", "Attack"]) {
      expect(pubsub.getMostRecent(`${topic}:Alice`)).toBeUndefined();
    }
  });

  it("has dropped a section by the time the new meta is published", () => {
    const member = new MemberData("Alice");
    const skills = { Overall: 0 };
    for (const name of ["Defence", "Hitpoints", "Prayer", "Attack", "Strength", "Ranged", "Magic"]) {
      skills[name] = 13034431;
    }
    member.update({
      meta: { categories: ["stats", "inventory", "location_live"] },
      coordinates: { x: 3222, y: 3219, plane: 0 },
      skills,
      inventory: [{ id: 4151, quantity: 2 }],
    });
    expect(member.combatLevel).toBe(126);

    // The profile draws itself again when what the player shares changes.
    const drawn = [];
    const draw = () => drawn.push([member.coordinates, member.combatLevel, member.inventory]);
    pubsub.subscribe("meta:Alice", draw, false);
    member.update({ meta: { categories: [] }, coordinates: null, skills: null, inventory: null });
    pubsub.unsubscribe("meta:Alice", draw);

    expect(drawn).toEqual([[undefined, undefined, undefined]]);
  });

  it("has the sections of a poll in place by the time its meta is published", () => {
    const member = new MemberData("Alice");
    const skills = { Overall: 0 };
    for (const name of ["Defence", "Hitpoints", "Prayer", "Attack", "Strength", "Ranged", "Magic"]) {
      skills[name] = 13034431;
    }
    const drawn = [];
    const draw = () => drawn.push([member.combatLevel, member.inventory?.[0]?.id]);
    pubsub.subscribe("meta:Alice", draw, false);
    member.update({ meta: { categories: ["stats", "inventory"] }, skills, inventory: [{ id: 4151, quantity: 2 }] });
    pubsub.unsubscribe("meta:Alice", draw);

    expect(drawn).toEqual([[126, 4151]]);
  });

  it("does not throw when combat level is computed with incomplete skills", () => {
    const member = new MemberData("Alice");
    member.skills = {
      Attack: { level: 99 },
      Strength: { level: 99 },
    };

    expect(() => member.computeCombatLevel()).not.toThrow();
    expect(member.combatLevel).toBeUndefined();
  });

  it("computes combat level when all required skills are present", () => {
    const member = new MemberData("Alice");
    member.skills = {
      Defence: { level: 99 },
      Hitpoints: { level: 99 },
      Prayer: { level: 99 },
      Attack: { level: 99 },
      Strength: { level: 99 },
      Ranged: { level: 99 },
      Magic: { level: 99 },
    };

    member.computeCombatLevel();

    expect(member.combatLevel).toBeGreaterThan(0);
  });
});
