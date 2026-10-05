import { describe, expect, it } from "vitest";
import {
  MAX_LEVEL,
  ancestorSource,
  levelForZoom,
  levelTileRect,
  levelTilesInView,
  minZoomToFit,
} from "../src/canvas-map/map-levels";

describe("levelForZoom", () => {
  it("is the full tiles from zoom 0.5 up", () => {
    expect(levelForZoom(6)).toBe(0);
    expect(levelForZoom(1)).toBe(0);
    expect(levelForZoom(0.5)).toBe(0);
  });

  it("goes a level coarser each time the zoom halves", () => {
    expect(levelForZoom(0.49)).toBe(1);
    expect(levelForZoom(0.25)).toBe(1);
    expect(levelForZoom(0.24)).toBe(2);
    expect(levelForZoom(0.125)).toBe(2);
    expect(levelForZoom(0.12)).toBe(3);
  });

  it("stops at the coarsest level", () => {
    expect(MAX_LEVEL).toBe(3);
    expect(levelForZoom(0.01)).toBe(3);
  });
});

describe("levelTileRect", () => {
  it("is a map tile's own square at level 0", () => {
    expect(levelTileRect(0, 3, 5)).toEqual({ x: 768, y: -1280, size: 256 });
  });

  it("covers 8 by 8 map tiles at level 3, from the top one down", () => {
    // Map tiles x 8..15 and y 32..39: the top is that of row 39.
    expect(levelTileRect(3, 1, 4)).toEqual({ x: 2048, y: -39 * 256, size: 2048 });
  });
});

describe("levelTilesInView", () => {
  it("lists the map tiles in view at level 0", () => {
    expect(levelTilesInView(0, { left: 2, right: 4, top: 6, bottom: 4 })).toEqual([
      [2, 6],
      [2, 5],
      [3, 6],
      [3, 5],
    ]);
  });

  it("lists every coarse tile that a map tile in view falls in", () => {
    // The overworld: map tiles x 15..62 and y 32..65.
    const tiles = levelTilesInView(3, { left: 15, right: 63, top: 65, bottom: 31 });
    expect(tiles).toHaveLength(7 * 5);
    expect(tiles).toContainEqual([1, 4]);
    expect(tiles).toContainEqual([7, 8]);
    expect(tiles).not.toContainEqual([8, 8]);
    expect(tiles).not.toContainEqual([1, 3]);
  });
});

describe("ancestorSource", () => {
  it("finds a tile's quarter of the tile one level up", () => {
    // x is odd: the right half. y is even: the lower half, as y goes up on the map.
    expect(ancestorSource(1, 5, 6)).toEqual({ x: 2, y: 3, sx: 128, sy: 128, size: 128 });
    expect(ancestorSource(1, 4, 7)).toEqual({ x: 2, y: 3, sx: 0, sy: 0, size: 128 });
  });

  it("finds a tile's part of a tile several levels up", () => {
    // Three levels up a tile is one of 8 by 8: column 5, and row 2 from the bottom.
    expect(ancestorSource(3, 13, 34)).toEqual({ x: 1, y: 4, sx: 160, sy: 160, size: 32 });
  });
});

describe("minZoomToFit", () => {
  it("fits the whole overworld on a 1080p screen", () => {
    // 48 by 34 map tiles: the height decides, 945 / 8704.
    expect(minZoomToFit(1920, 945)).toBe(27 / 256);
  });

  it("keeps a map tile a whole number of pixels", () => {
    expect((minZoomToFit(800, 600) * 256) % 1).toBe(0);
    expect(minZoomToFit(800, 600)).toBe(16 / 256);
  });

  it("never zooms in further than the map did before", () => {
    expect(minZoomToFit(8000, 6000)).toBe(0.5);
  });

  it("never gets to nothing", () => {
    expect(minZoomToFit(10, 10)).toBe(1 / 256);
    expect(minZoomToFit(0, 0)).toBe(1 / 256);
  });
});
