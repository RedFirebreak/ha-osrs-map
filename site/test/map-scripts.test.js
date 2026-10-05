import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// The scripts that make the map's data: what build.js puts in map.json, and
// the parts of generate-map-levels.js that decide what goes where. Shrinking
// the images themselves needs sharp, which is not installed for the tests.

const require = createRequire(import.meta.url);
const { buildMapJson } = require("../scripts/map-json.js");
const { levelGroups, majorLabelOrder, dominantColor } = require("../scripts/generate-map-levels.js");

const cantor = (x, y) => ((x + y) * (x + y + 1)) / 2 + y;

describe("buildMapJson", () => {
  let dir;

  function publicDir(files) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-json-"));
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    }
    return dir;
  }

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const DATA = {
    "data/map_icons.json": { 50: { 50: { 3: [3200, 3200, 0] } } },
    "data/map_labels.json": { 50: { 50: { 0: [3200, 3200, 7] } } },
    "data/map_links.json": { "3200,3200,0": [3200, 9600, 0] },
  };

  it("lists the map tiles per floor, with the icons, the labels and the links", () => {
    const map = buildMapJson(
      publicDir({ ...DATA, "map/0_50_50.webp": "", "map/0_51_50.webp": "", "map/2_50_50.webp": "" }),
    );
    expect(map.tiles).toEqual([[cantor(50, 50), cantor(51, 50)], [], [cantor(50, 50)], []]);
    expect(map.icons).toEqual(DATA["data/map_icons.json"]);
    expect(map.labels).toEqual(DATA["data/map_labels.json"]);
    expect(map.links).toEqual(DATA["data/map_links.json"]);
  });

  it("lists the coarser tiles per level and floor", () => {
    const map = buildMapJson(
      publicDir({
        ...DATA,
        "map/0_50_50.webp": "",
        "map/zoom/1/0_25_25.webp": "",
        "map/zoom/3/0_6_6.webp": "",
        "map/zoom/3/1_6_6.webp": "",
      }),
    );
    expect(map.levels).toEqual({
      1: [[cantor(25, 25)], [], [], []],
      3: [[cantor(6, 6)], [cantor(6, 6)], [], []],
    });
    // The coarser tiles are not map tiles.
    expect(map.tiles).toEqual([[cantor(50, 50)], [], [], []]);
  });

  it("has no levels when none were generated", () => {
    const map = buildMapJson(publicDir({ ...DATA, "map/0_50_50.webp": "" }));
    expect(map.levels).toEqual({});
  });

  it("says which labels name a region or a sea, in their order", () => {
    const map = buildMapJson(publicDir({ ...DATA, "map/0_50_50.webp": "", "data/map_major_labels.json": [7, 3] }));
    expect(map.majorLabels).toEqual([7, 3]);
  });

  it("names no regions when that was not generated", () => {
    const map = buildMapJson(publicDir({ ...DATA, "map/0_50_50.webp": "" }));
    expect(map.majorLabels).toEqual([]);
  });

  it("does without the links", () => {
    const files = { ...DATA, "map/0_50_50.webp": "" };
    delete files["data/map_links.json"];
    expect(buildMapJson(publicDir(files)).links).toEqual({});
  });
});

describe("levelGroups", () => {
  it("puts each map tile in the coarse tile it belongs to, at its place in the image", () => {
    const groups = levelGroups(["0_8_32", "0_9_33", "0_10_32"], 1);
    expect([...groups.keys()].sort()).toEqual(["0_4_16", "0_5_16"]);
    // Two by two map tiles, 128 pixels each. y goes up on the map and down in the image.
    expect(groups.get("0_4_16")).toEqual([
      { tile: "0_8_32", left: 0, top: 128, size: 128 },
      { tile: "0_9_33", left: 128, top: 0, size: 128 },
    ]);
    expect(groups.get("0_5_16")).toEqual([{ tile: "0_10_32", left: 0, top: 128, size: 128 }]);
  });

  it("keeps the floors apart", () => {
    const groups = levelGroups(["0_8_32", "1_8_32"], 1);
    expect([...groups.keys()].sort()).toEqual(["0_4_16", "1_4_16"]);
  });

  it("shrinks 8 by 8 map tiles into one image at level 3", () => {
    const groups = levelGroups(["0_13_34"], 3);
    expect(groups.get("0_1_4")).toEqual([{ tile: "0_13_34", left: 160, top: 160, size: 32 }]);
  });

  it("leaves out the floors that were not asked for", () => {
    const groups = levelGroups(["0_8_32", "1_8_32", "2_8_32"], 1, [0, 2]);
    expect([...groups.keys()].sort()).toEqual(["0_4_16", "2_4_16"]);
  });
});

describe("dominantColor", () => {
  /** An image of pixels, each `[r, g, b, a]`, as raw bytes. */
  const pixels = (...list) => Buffer.from(list.flat());
  const ORANGE = [255, 152, 31, 255];
  const BLACK = [0, 0, 0, 255];
  const CLEAR = [9, 9, 9, 0];

  it("is the colour most of the text is in", () => {
    expect(dominantColor(pixels(ORANGE, ORANGE, [1, 2, 3, 255]))).toBe("255,152,31");
  });

  it("is not the black of the text's shadow, nor what is see-through", () => {
    expect(dominantColor(pixels(BLACK, BLACK, BLACK, CLEAR, CLEAR, CLEAR, CLEAR, ORANGE))).toBe("255,152,31");
  });

  it("is nothing for an empty image", () => {
    expect(dominantColor(pixels(CLEAR, BLACK))).toBeNull();
  });
});

describe("majorLabelOrder", () => {
  const ORANGE = "255,152,31";
  const CYAN = "29,224,224";

  it("keeps the names of the regions and the seas, and no other", () => {
    const order = majorLabelOrder([
      { id: 1, width: 60, height: 14, color: "255,255,255" },
      { id: 2, width: 90, height: 30, color: ORANGE },
      { id: 3, width: 60, height: 30, color: CYAN },
      { id: 4, width: 63, height: 14, color: "255,255,0" },
    ]);
    expect(order).toEqual([2, 3]);
  });

  it("puts the regions before the seas, and of each the largest name first", () => {
    const order = majorLabelOrder([
      { id: 1, width: 80, height: 30, color: CYAN },
      { id: 2, width: 130, height: 13, color: ORANGE },
      { id: 3, width: 90, height: 30, color: ORANGE },
      { id: 4, width: 60, height: 30, color: CYAN },
    ]);
    expect(order).toEqual([3, 2, 1, 4]);
  });

  it("is the same whatever order the labels come in", () => {
    const labels = [
      { id: 9, width: 90, height: 30, color: ORANGE },
      { id: 4, width: 90, height: 30, color: ORANGE },
    ];
    expect(majorLabelOrder(labels)).toEqual([4, 9]);
    expect(majorLabelOrder(labels.slice().reverse())).toEqual([4, 9]);
  });
});
