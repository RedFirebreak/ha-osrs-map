#!/usr/bin/env node
// Builds what the map needs to be zoomed far out, from the map tiles and the
// labels that are in public/ already:
//
// - public/map/zoom/<level>/<plane>_<x>_<y>.webp: the terrain in coarser
//   levels. A tile of level n is 256 pixels for 2^n by 2^n map tiles, so the
//   whole overworld is 35 images at level 3 where it is 1,632 map tiles. The
//   map picks the level by its zoom (src/canvas-map/map-levels.js).
// - public/data/map_major_labels.json: the labels that name a region or a
//   sea, the only ones the map shows far zoomed out. The label images say
//   which those are by their colour. They are in the order the map keeps them
//   in where two would be drawn over each other.
//
//   npm install --no-save sharp
//   node scripts/generate-map-levels.js [--planes 0,1]
//
// Run it again when the map tiles or the labels change, and commit what it
// writes: build.js only lists what is there (scripts/map-json.js). It makes
// levels for all four floors unless told which; the map draws a floor without
// levels from its map tiles, as it did before there were any. sharp is not
// among the site's dependencies, as nothing else needs it.
const fs = require("fs");
const path = require("path");

const TILE_SIZE = 256;
const LEVELS = [1, 2, 3];
// The colours of the names of regions and of seas on the game's world map.
const REGION_COLOR = "255,152,31";
const SEA_COLOR = "29,224,224";

/**
 * Which map tiles go into which tile of a level. `tiles` are map tile names
 * (`<plane>_<x>_<y>`); the result maps the name of each coarse tile to its
 * map tiles, each with its place and size in the coarse tile's image.
 */
function levelGroups(tiles, level, planes = null) {
  const span = 2 ** level;
  const size = TILE_SIZE / span;
  const groups = new Map();
  for (const tile of tiles) {
    const [plane, x, y] = tile.split("_").map((part) => parseInt(part, 10));
    if (planes && !planes.includes(plane)) continue;
    const name = `${plane}_${Math.floor(x / span)}_${Math.floor(y / span)}`;
    if (!groups.has(name)) groups.set(name, []);
    // y goes up on the map and down in the image.
    groups.get(name).push({ tile, left: (x % span) * size, top: (span - 1 - (y % span)) * size, size });
  }
  return groups;
}

/** The colour (`"r,g,b"`) most of an image's opaque pixels have, black aside; null when it has none. */
function dominantColor(rgba) {
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue;
    const color = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
    if (color !== "0,0,0") counts.set(color, (counts.get(color) || 0) + 1);
  }
  let best = null;
  for (const [color, count] of counts) {
    if (best === null || count > counts.get(best)) best = color;
  }
  return best;
}

/**
 * The ids of the labels that name a region or a sea, of `{id, width, height,
 * color}`: the regions first, then the seas, and of each the largest first.
 */
function majorLabelOrder(labels) {
  const rank = (label) => (label.color === REGION_COLOR ? 0 : 1);
  return labels
    .filter((label) => label.color === REGION_COLOR || label.color === SEA_COLOR)
    .sort((a, b) => rank(a) - rank(b) || b.width * b.height - a.width * a.height || a.id - b.id)
    .map((label) => label.id);
}

async function writeLevels(sharp, mapDir, planes) {
  const tiles = fs
    .readdirSync(mapDir)
    .filter((file) => file.endsWith(".webp"))
    .map((file) => path.basename(file, ".webp"));

  for (const level of LEVELS) {
    const dir = path.join(mapDir, "zoom", String(level));
    fs.mkdirSync(dir, { recursive: true });
    // What was made before for these floors may be of map tiles that are gone.
    for (const file of fs.readdirSync(dir)) {
      if (planes.includes(parseInt(file, 10))) fs.rmSync(path.join(dir, file));
    }

    const groups = levelGroups(tiles, level, planes);
    let bytes = 0;
    for (const [name, parts] of groups) {
      const pieces = await Promise.all(
        parts.map(async ({ tile, left, top, size }) => ({
          input: await sharp(path.join(mapDir, `${tile}.webp`))
            .resize(size, size, { kernel: "mitchell" })
            .png()
            .toBuffer(),
          left,
          top,
        })),
      );
      const image = await sharp({
        create: { width: TILE_SIZE, height: TILE_SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite(pieces)
        .webp({ quality: 85, effort: 6 })
        .toBuffer();
      fs.writeFileSync(path.join(dir, `${name}.webp`), image);
      bytes += image.length;
    }
    console.log(`level ${level}: ${groups.size} tiles, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  }
}

async function writeMajorLabels(sharp, labelDir, target) {
  const labels = [];
  for (const file of fs.readdirSync(labelDir)) {
    if (!file.endsWith(".webp")) continue;
    const { data, info } = await sharp(path.join(labelDir, file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    labels.push({
      id: parseInt(path.basename(file, ".webp"), 10),
      width: info.width,
      height: info.height,
      color: dominantColor(data),
    });
  }
  const major = majorLabelOrder(labels);
  fs.writeFileSync(target, JSON.stringify(major) + "\n");
  console.log(`${major.length} of ${labels.length} labels name a region or a sea`);
}

async function main() {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    console.error("sharp is not installed: run `npm install --no-save sharp` first");
    process.exit(1);
  }

  const planesAt = process.argv.indexOf("--planes");
  const planes = (planesAt < 0 ? "0,1,2,3" : process.argv[planesAt + 1] || "")
    .split(",")
    .map((plane) => parseInt(plane, 10));
  if (planes.some((plane) => !(plane >= 0 && plane <= 3))) {
    console.error("usage: node scripts/generate-map-levels.js [--planes 0,1]");
    process.exit(1);
  }

  const publicDir = path.join(__dirname, "../public");
  await writeLevels(sharp, path.join(publicDir, "map"), planes);
  await writeMajorLabels(sharp, path.join(publicDir, "map/labels"), path.join(publicDir, "data/map_major_labels.json"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { levelGroups, dominantColor, majorLabelOrder };
