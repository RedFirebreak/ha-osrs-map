import { describe, expect, it, vi } from "vitest";
import { ICON_SPRITE_SIZE } from "../src/canvas-map/canvas-map";
import { centerOn, createMap, createMockCtx, setMapLinks } from "./helpers/map";

// The map zoomed out further than it went before: down to the whole overworld
// on one screen. The terrain comes from coarser tiles there, and less is drawn
// on it.

/** A map looking at map tiles x 8..15 and y 32..39, which is one tile of level 3. */
function createFarMap(zoom) {
  const map = createMap();
  map.ctx = createMockCtx();
  map.camera.zoom.current = zoom;
  map.view = { left: 8, right: 16, top: 39, bottom: 31 };
  const valid = new Set();
  for (let x = 8; x < 16; ++x) for (let y = 32; y < 40; ++y) valid.add(map.cantor(x, y));
  map.validTiles = [valid, new Set(), new Set(), new Set()];
  return map;
}

/** Which tiles of a level there are, per floor: here on the ground floor only. */
function levelOf(map, tiles) {
  return [new Set(tiles.map(([x, y]) => map.cantor(x, y))), new Set(), new Set(), new Set()];
}

const sources = (map) => map.tilesInView.map((tile) => new URL(tile.src).pathname).sort();
const shown = (tile) => Object.assign(tile, { loaded: true, animation: { current: 1 } });

describe("the least zoom", () => {
  function resize(map, width, height) {
    Object.defineProperty(map, "offsetWidth", { value: width, configurable: true });
    Object.defineProperty(map, "offsetHeight", { value: height, configurable: true });
    map.onResize();
  }

  it("is the zoom at which the whole overworld fits the map", () => {
    const map = createMap();
    map.ctx = createMockCtx();
    resize(map, 1920, 945);
    expect(map.camera.minZoom).toBe(27 / 256);
    resize(map, 800, 600);
    expect(map.camera.minZoom).toBe(16 / 256);
  });

  it("is left alone before the map has a camera", () => {
    const map = createMap();
    map.ctx = createMockCtx();
    map.camera = undefined;
    expect(() => resize(map, 1920, 945)).not.toThrow();
  });

  it("can be scrolled out to", () => {
    const map = createMap();
    map.ctx = createMockCtx();
    resize(map, 1920, 945);
    map.camera.zoom.goTo(0.5, 1);
    for (let i = 0; i < 40; ++i) map.onScroll({ deltaY: 1 });
    expect(map.camera.zoom.target).toBe(27 / 256);
  });

  it("keeps what is under the pointer where it is, wherever on the map that is", () => {
    const map = createMap();
    map.ctx = createMockCtx();
    resize(map, 1920, 945);
    map.camera.zoom.goTo(0.5, 1);
    // Underground, far from the overworld, with the pointer in a corner of the map.
    centerOn(map, 3200, 9800);
    map.cursor.x = 1900;
    map.cursor.y = 900;
    const underPointer = () => [
      (map.cursor.x + map.camera.x.target) / map.camera.zoom.target,
      (map.cursor.y - map.camera.y.target) / map.camera.zoom.target,
    ];
    const [x, y] = underPointer();
    for (let i = 0; i < 40; ++i) map.onScroll({ deltaY: 1 });
    expect(map.camera.zoom.target).toBe(27 / 256);
    expect(underPointer()[0]).toBeCloseTo(x, 6);
    expect(underPointer()[1]).toBeCloseTo(y, 6);
  });
});

describe("the terrain, far zoomed out", () => {
  it("is drawn from one coarse tile where it was 64 map tiles", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 3: levelOf(map, [[1, 4]]) };
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/zoom/3/0_1_4.webp"]);
    expect(map.tiles[0].size).toBe(0);
  });

  it("takes the level that fits the zoom", () => {
    const map = createFarMap(0.3);
    map.validLevelTiles = {
      1: levelOf(map, [
        [4, 16],
        [5, 16],
      ]),
      3: levelOf(map, [[1, 4]]),
    };
    map.view = { left: 8, right: 12, top: 33, bottom: 31 };
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/zoom/1/0_4_16.webp", "/map/zoom/1/0_5_16.webp"]);
  });

  it("takes the nearest finer level when the one for the zoom was not made", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 2: levelOf(map, [[2, 8]]) };
    map.view = { left: 8, right: 12, top: 35, bottom: 31 };
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/zoom/2/0_2_8.webp"]);
  });

  it("is the map tiles themselves when no levels were made", () => {
    const map = createFarMap(0.1);
    map.view = { left: 8, right: 9, top: 32, bottom: 31 };
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/0_8_32.webp"]);
  });

  it("is the map tiles themselves on a floor without levels", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 3: levelOf(map, [[1, 4]]) };
    map.validTiles[1] = map.validTiles[0];
    map.plane = 2;
    map.view = { left: 8, right: 9, top: 32, bottom: 31 };
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/1_8_32.webp"]);
  });

  it("is the map tiles themselves from zoom 0.5 up", () => {
    const map = createFarMap(0.5);
    map.validLevelTiles = { 1: levelOf(map, [[4, 16]]), 3: levelOf(map, [[1, 4]]) };
    map.view = { left: 8, right: 9, top: 32, bottom: 31 };
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/0_8_32.webp"]);
  });

  it("clears where the level has no tile", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 3: levelOf(map, [[5, 5]]) };
    map.drawMapSquaresInView(true);
    expect(map.tilesInView).toHaveLength(0);
    expect(map.ctx.clearRect).toHaveBeenCalledWith(2048, -39 * 256, 2048, 2048);
  });

  it("draws a coarse tile over all the ground it stands for", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 3: levelOf(map, [[1, 4]]) };
    map.drawMapSquaresInView(true);
    const [tile] = map.tilesInView;
    shown(tile);
    map.drawMapSquaresInView(true);
    expect(map.ctx.drawImage).toHaveBeenCalledWith(tile, 2048, -39 * 256, 2048, 2048);
  });

  it("clears a coarse tile's square before every time it draws it", () => {
    // The image is see-through where there are no map tiles: what was drawn
    // there before the map was dragged would stay on the canvas.
    const map = createFarMap(0.1);
    map.validLevelTiles = { 3: levelOf(map, [[1, 4]]) };
    map.drawMapSquaresInView(true);
    shown(map.tilesInView[0]);
    map.ctx.clearRect.mockClear();
    map.drawMapSquaresInView(true);
    expect(map.ctx.clearRect).toHaveBeenCalledWith(2048, -39 * 256, 2048, 2048);
    expect(map.ctx.clearRect.mock.invocationCallOrder[0]).toBeLessThan(map.ctx.drawImage.mock.invocationCallOrder[0]);
  });

  it("shows a coarser tile that is there already while a finer one loads", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 2: levelOf(map, [[3, 8]]), 3: levelOf(map, [[1, 4]]) };
    map.drawMapSquaresInView(true);
    const [coarse] = map.tilesInView;
    shown(coarse);

    // Zoomed in a step: map tiles x 12..15 and y 32..35 are the lower right quarter of the coarse tile.
    map.camera.zoom.current = 0.2;
    map.view = { left: 12, right: 16, top: 35, bottom: 31 };
    map.ctx.drawImage.mockClear();
    map.drawMapSquaresInView(true);
    expect(sources(map)).toEqual(["/map/zoom/2/0_3_8.webp"]);
    expect(map.ctx.drawImage).toHaveBeenCalledWith(coarse, 128, 128, 128, 128, 3072, -35 * 256, 1024, 1024);
  });

  it("stops showing the coarser tile once the finer one is there", () => {
    const map = createFarMap(0.1);
    map.validLevelTiles = { 2: levelOf(map, [[3, 8]]), 3: levelOf(map, [[1, 4]]) };
    map.drawMapSquaresInView(true);
    shown(map.tilesInView[0]);
    map.camera.zoom.current = 0.2;
    map.view = { left: 12, right: 16, top: 35, bottom: 31 };
    map.drawMapSquaresInView(true);
    const [fine] = map.tilesInView;
    shown(fine);
    map.ctx.drawImage.mockClear();
    map.drawMapSquaresInView(true);
    expect(map.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(map.ctx.drawImage).toHaveBeenCalledWith(fine, 3072, -35 * 256, 1024, 1024);
  });
});

describe("the map's icons, far zoomed out", () => {
  function createIconMap(zoom) {
    const map = createFarMap(zoom);
    map.locationIconsSheet = { width: 100, height: 100 };
    map.locations = { 10: { 33: { 4: [660, 2130, 0] } } };
    map.linkedIconPositions = new Set(["660,2130,0"]);
    return map;
  }

  it("are drawn for what is in view, whatever the terrain is drawn from", () => {
    const map = createIconMap(0.1);
    map.tilesInView = [];
    map.drawLocations();
    expect(map.ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it("are left out where the map is not in view", () => {
    const map = createIconMap(0.1);
    map.view = { left: 20, right: 28, top: 39, bottom: 31 };
    map.drawLocations();
    expect(map.ctx.drawImage).not.toHaveBeenCalled();
  });

  it("keep their size on screen down to zoom 0.5", () => {
    const map = createIconMap(0.5);
    expect(map.iconCanvasSize() * 0.5).toBe(ICON_SPRITE_SIZE);
  });

  it("shrink with the map below that", () => {
    const map = createIconMap(0.3);
    expect(map.iconCanvasSize() * 0.3).toBeCloseTo(ICON_SPRITE_SIZE * 0.6);
  });

  it("stay 7 pixels however far the map is zoomed out", () => {
    const map = createIconMap(0.1);
    expect(map.iconCanvasSize() * 0.1).toBeCloseTo(7);
    map.camera.zoom.current = 0.02;
    expect(map.iconCanvasSize() * 0.02).toBeCloseTo(7);
  });

  it("have no ring around the ones that lead somewhere", () => {
    const map = createIconMap(0.2);
    map.drawLocations();
    expect(map.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(map.ctx.arc).not.toHaveBeenCalled();
  });

  it("have their ring again from zoom 0.3 up", () => {
    const map = createIconMap(0.3);
    map.drawLocations();
    expect(map.ctx.arc).toHaveBeenCalledTimes(1);
  });
});

describe("the links, far zoomed out", () => {
  function createLinkMap(zoom) {
    const map = createFarMap(zoom);
    setMapLinks(map, { "660,2129,0": { x: 700, y: 9000, plane: 0 } });
    centerOn(map, 660, 2130);
    return map;
  }

  it("are not drawn", () => {
    const map = createLinkMap(0.2);
    map.drawMapLinks();
    expect(map.ctx.arc).not.toHaveBeenCalled();
  });

  it("are not under the pointer", () => {
    const map = createLinkMap(0.2);
    const [x, y] = map.mapLinkScreenCenter(660, 2130);
    expect(map.linkAt(x, y)).toBeNull();
  });

  it("are drawn and under the pointer from zoom 0.3 up", () => {
    const map = createLinkMap(0.3);
    map.drawMapLinks();
    expect(map.ctx.arc).toHaveBeenCalledTimes(1);
    const [x, y] = map.mapLinkScreenCenter(660, 2130);
    expect(map.linkAt(x, y)).not.toBeNull();
  });
});

describe("the names, far zoomed out", () => {
  const LABELS = [
    [520, 2060, 5],
    [570, 2060, 7],
    [900, 2060, 6],
  ];

  /** Names 5 and 7 are 50 game tiles apart, 6 is far from both. Each is 100 by 20 pixels. */
  function createLabelMap(zoom, { loaded = true } = {}) {
    const map = createFarMap(zoom);
    map.mapLabels = { 8: { 32: { 0: [...LABELS[0], ...LABELS[1]] } }, 14: { 32: { 0: LABELS[2] } } };
    map.mapLabelImages = new Map();
    if (loaded) {
      for (const [x, y, id] of LABELS) {
        const key = map.coordinateKey(...map.gamePositionToCanvas(x, y));
        map.mapLabelImages.set(key, { loaded: true, complete: true, width: 100, height: 20, id });
      }
    }
    return map;
  }

  const drawn = (map) => map.ctx.drawImage.mock.calls.map(([image]) => image.id).sort();

  it("are all drawn from zoom 0.3 up", () => {
    const map = createLabelMap(0.3);
    map.majorLabels = new Map([[7, 0]]);
    map.drawMapAreaLabels(true);
    expect(drawn(map)).toEqual([5, 6, 7]);
  });

  it("are those of the regions and the seas only", () => {
    const map = createLabelMap(0.2);
    map.majorLabels = new Map([
      [6, 0],
      [7, 1],
    ]);
    map.drawMapAreaLabels(true);
    expect(drawn(map)).toEqual([6, 7]);
  });

  it("are all drawn when the map does not say which are the regions", () => {
    const map = createLabelMap(0.2);
    map.drawMapAreaLabels(true);
    expect(drawn(map)).toEqual([5, 6, 7]);
  });

  it("leave out a name that would be drawn over one that comes first", () => {
    // At zoom 0.1 the 50 game tiles between 5 and 7 are 20 pixels, and a name is 100 wide.
    const map = createLabelMap(0.1);
    map.majorLabels = new Map([
      [7, 0],
      [5, 1],
      [6, 2],
    ]);
    map.drawMapAreaLabels(true);
    expect(drawn(map)).toEqual([6, 7]);
  });

  it("don't have the images loaded of those that are left out", () => {
    const map = createLabelMap(0.2, { loaded: false });
    map.majorLabels = new Map([[6, 0]]);
    map.drawMapAreaLabels(true);
    expect(map.mapLabelImages.size).toBe(1);
  });
});

describe("the map's data", () => {
  async function load(map, data) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => data })),
    );
    try {
      await map.getMapJson();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("says which coarse tiles and which region names there are", async () => {
    const map = createMap();
    await load(map, {
      tiles: [[map.cantor(8, 32)], [], [], []],
      icons: {},
      labels: {},
      links: {},
      levels: { 3: [[map.cantor(1, 4)], [], [], []] },
      majorLabels: [458, 317],
    });
    expect(map.validLevelTiles[3][0].has(map.cantor(1, 4))).toBe(true);
    expect(map.majorLabels.get(458)).toBe(0);
    expect(map.majorLabels.get(317)).toBe(1);
  });

  it("may be from before there were levels", async () => {
    const map = createMap();
    await load(map, { tiles: [[], [], [], []], icons: {}, labels: {}, links: {} });
    expect(map.validLevelTiles).toEqual({});
    expect(map.majorLabels.size).toBe(0);
  });
});
