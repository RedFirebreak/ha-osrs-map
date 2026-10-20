import { beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const dataDir = path.resolve(__dirname, "../public/data");

function loadJson(filename) {
  const raw = fs.readFileSync(path.join(dataDir, filename), "utf-8");
  return JSON.parse(raw);
}

function expectNumericKeys(obj) {
  for (const key of Object.keys(obj)) {
    expect(key).toMatch(/^\d+$/);
    expect(Number(key)).toBeGreaterThanOrEqual(0);
  }
}

let itemData, mapLinks;

beforeAll(() => {
  itemData = loadJson("item_data.json");
  mapLinks = loadJson("map_links.json");
});

describe("cache data validation", () => {
  describe("item_data.json", () => {
    it("is valid JSON", () => {
      expect(itemData).toBeDefined();
      expect(typeof itemData).toBe("object");
    });

    it("has > 15000 entries", () => {
      expect(Object.keys(itemData).length).toBeGreaterThan(15000);
    });

    it("every entry has name and highalch", () => {
      for (const item of Object.values(itemData)) {
        expect(typeof item.name).toBe("string");
        expect(item.name.trim().length).toBeGreaterThan(0);
        expect(typeof item.highalch).toBe("number");
        expect(item.highalch).toBeGreaterThanOrEqual(0);
      }
    });

    it("all keys are numeric strings representing positive integers", () => {
      expectNumericKeys(itemData);
    });

    it("optional stacks field is valid when present", () => {
      for (const item of Object.values(itemData)) {
        if (item.stacks === undefined || item.stacks === null) continue;
        expect(Array.isArray(item.stacks)).toBe(true);
        for (const pair of item.stacks) {
          expect(Array.isArray(pair)).toBe(true);
          expect(pair.length).toBe(2);
          expect(Number.isInteger(pair[0])).toBe(true);
          expect(pair[0]).toBeGreaterThan(0);
          expect(Number.isInteger(pair[1])).toBe(true);
          expect(pair[1]).toBeGreaterThan(0);
        }
      }
    });

    it("known items are present", () => {
      expect(itemData["4151"]).toBeDefined();
      expect(itemData["4151"].name).toBe("Abyssal whip");
      expect(itemData["995"]).toBeDefined();
      expect(itemData["995"].name).toBe("Coins");
      expect(itemData["1"]).toBeDefined();
      expect(itemData["1"].name).toBe("Toolkit");
    });
  });

  describe("map_links.json", () => {
    it("maps an x,y,plane key to a destination", () => {
      expect(Object.keys(mapLinks).length).toBeGreaterThan(0);
      for (const [key, destination] of Object.entries(mapLinks)) {
        expect(key).toMatch(/^\d+,\d+,\d$/);
        expect(destination).toHaveLength(3);
      }
    });
  });
});
