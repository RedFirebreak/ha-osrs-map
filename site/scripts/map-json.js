// What build.js writes to public/data/map.json: all the map needs to know
// before it draws, in one request. Which tiles there are comes from the
// images themselves; the rest from the data files beside the item list.
const fs = require("fs");
const path = require("path");

/** The tiles in a folder (`<plane>_<x>_<y>.webp`) per floor, each as the number the map knows it by. */
function tilesByFloor(dir) {
  const tiles = [[], [], [], []];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".webp")) continue;
    const [plane, x, y] = path
      .basename(file, ".webp")
      .split("_")
      .map((part) => parseInt(part, 10));
    tiles[plane].push(((x + y) * (x + y + 1)) / 2 + y);
  }
  return tiles;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

/**
 * The map's data, from a `public` folder. The coarser levels of the terrain
 * (`map/zoom/<level>/`) and the labels that name a region or a sea
 * (`data/map_major_labels.json`) are there once scripts/generate-map-levels.js
 * has run; without them the map draws its tiles and labels as they are.
 */
function buildMapJson(publicDir) {
  const mapDir = path.join(publicDir, "map");
  const dataDir = path.join(publicDir, "data");

  const levels = {};
  const zoomDir = path.join(mapDir, "zoom");
  if (fs.existsSync(zoomDir)) {
    for (const level of fs.readdirSync(zoomDir)) {
      levels[level] = tilesByFloor(path.join(zoomDir, level));
    }
  }

  return {
    tiles: tilesByFloor(mapDir),
    icons: readJson(path.join(dataDir, "map_icons.json")),
    labels: readJson(path.join(dataDir, "map_labels.json")),
    links: readJson(path.join(dataDir, "map_links.json"), {}),
    levels,
    majorLabels: readJson(path.join(dataDir, "map_major_labels.json"), []),
  };
}

module.exports = { buildMapJson };
