import { vi } from "vitest";
import { Animation } from "../../src/canvas-map/animation";
import { CanvasMap } from "../../src/canvas-map/canvas-map";

/**
 * The map as the tests use it: never connected to a page, with what
 * `connectedCallback` would have set up put in by hand. An 800 by 600 canvas
 * at zoom 1, the ground floor, nobody on it. A test that draws gives it a
 * `ctx` of its own.
 */
export function createMap() {
  const map = new CanvasMap();
  map.plane = 1;
  map.canvas = { width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  map.camera = {
    x: new Animation({ current: 0, target: 0, progress: 1 }),
    y: new Animation({ current: 0, target: 0, progress: 1 }),
    zoom: new Animation({ current: 1, target: 1, progress: 1 }),
    maxZoom: 6,
    minZoom: 0.5,
    isDragging: false,
  };
  map.cursor = { x: 0, y: 0, frameX: [0], frameY: [0] };
  map.touch = {};
  map.playerMarkers = new Map();
  map.renderedPlayers = [];
  map.followingPlayer = {};
  map.tiles = [new Map(), new Map(), new Map(), new Map()];
  map.tilesInView = [];
  map.updateRequested = 0;
  map.coordinatesDisplay = { innerText: "" };
  return map;
}

/** A canvas context that draws nothing and remembers what it was asked to. */
export function createMockCtx() {
  return {
    resetTransform: vi.fn(),
    setTransform: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    globalAlpha: 1,
    beginPath: vi.fn(),
    rect: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    arc: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    strokeRect: vi.fn(),
    fillRect: vi.fn(),
    measureText: vi.fn((text) => ({ width: text.length * 7 })),
    imageSmoothingEnabled: true,
  };
}

/** Gives the map its links, keyed `"x,y,plane"` as map.json has them. */
export function setMapLinks(map, links) {
  map.linksByPlane = {};
  for (const [key, destination] of Object.entries(links)) {
    const [x, y, plane] = key.split(",").map(Number);
    if (!map.linksByPlane[plane]) map.linksByPlane[plane] = [];
    const linkKey = `${x},${y + 1},${plane}`;
    map.linksByPlane[plane].push({ key: linkKey, x, y: y + 1, plane, destination });
  }
}

/** Puts a game tile in the middle of the map, at once. */
export function centerOn(map, x, y) {
  const [cx, cy] = map.gamePositionToCameraCenter(x, y);
  map.camera.x.current = cx;
  map.camera.y.current = cy;
}
