// The terrain in zoom levels. Level 0 is the map tiles themselves, 256 pixels
// for 64 by 64 game tiles. A tile of level n is the same 256 pixels for 2^n by
// 2^n map tiles, shrunk beforehand by scripts/generate-map-levels.js, so a map
// that is zoomed far out loads and draws a few dozen images, not thousands.
//
// A tile of level n is numbered by the map tiles in it: the map tile's x and y
// divided by 2^n, rounded down.

import { MAP_TILE_SIZE } from "./map-space";

export const MAX_LEVEL = 3;

// The overworld: the block of map tiles with the surface and the sea around it.
const OVERWORLD = { left: 15, right: 62, bottom: 32, top: 65 };

// The map never asked for less zoom than this before it had levels, and doesn't
// ask for more than this as the least on a screen the overworld is small on.
const MIN_ZOOM_AT_MOST = 0.5;

/** The level whose tiles are between a half and their full size on screen at a zoom. */
export function levelForZoom(zoom) {
  let level = 0;
  while (level < MAX_LEVEL && zoom * 2 ** (level + 1) < 1) ++level;
  return level;
}

/** Where a tile of a level is drawn, in map pixels: its top left corner and its size. */
export function levelTileRect(level, x, y) {
  const span = 2 ** level;
  return {
    x: x * span * MAP_TILE_SIZE,
    // y goes up in map tiles and down in map pixels: the top is that of the highest map tile in it.
    y: -(y * span + span - 1) * MAP_TILE_SIZE,
    size: span * MAP_TILE_SIZE,
  };
}

/**
 * The tiles of a level that are in view, as `[x, y]`. `view` is in map tiles,
 * as the map keeps it: x from `left` up to `right`, y from `top` down to
 * `bottom`, without `right` and `bottom` themselves.
 */
export function levelTilesInView(level, view) {
  const tiles = [];
  for (let x = view.left >> level; x <= (view.right - 1) >> level; ++x) {
    for (let y = view.top >> level; y >= (view.bottom + 1) >> level; --y) {
      tiles.push([x, y]);
    }
  }
  return tiles;
}

/**
 * The part of a coarser tile that shows the same ground as tile `x`, `y`:
 * the tile `steps` levels up (`x`, `y`) and the square of its image (`sx`,
 * `sy`, `size`).
 */
export function ancestorSource(steps, x, y) {
  const span = 2 ** steps;
  const size = MAP_TILE_SIZE / span;
  return {
    x: x >> steps,
    y: y >> steps,
    sx: (x % span) * size,
    sy: (span - 1 - (y % span)) * size,
    size,
  };
}

/**
 * The least zoom of a canvas: the one at which the whole overworld fits on it,
 * wherever on the map it is looking. A map tile stays a whole number of
 * pixels, as zooming keeps it.
 */
export function minZoomToFit(width, height) {
  const tilesWide = OVERWORLD.right - OVERWORLD.left + 1;
  const tilesHigh = OVERWORLD.top - OVERWORLD.bottom + 1;
  const tilePx = Math.floor(Math.min(width / tilesWide, height / tilesHigh));
  return Math.min(Math.max(tilePx, 1) / MAP_TILE_SIZE, MIN_ZOOM_AT_MOST);
}
