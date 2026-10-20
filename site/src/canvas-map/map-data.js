// The world map's terrain, place names and icons come from osrs-icons, which draws them from each
// game update's cache and publishes them next to the item icons. This module knows where they are
// and turns osrs-icons' data/map.json into what the map works with. Only the links between places
// (data/map_links.json) are still this site's own.
//
// The server injects the base URL as window.siteConfig.mapBaseUrl (MAP_BASE_URL). Unlike icons the
// map can't be turned off, so an empty value means the default too.

export const DEFAULT_MAP_BASE_URL = "https://icons.scapekeeper.com";

/** The configured map base URL, without trailing slashes. */
export function mapBase() {
  const configured = typeof window === "undefined" ? undefined : window.siteConfig?.mapBaseUrl;
  const base = String(configured ?? "")
    .trim()
    .replace(/\/+$/, "");
  return base || DEFAULT_MAP_BASE_URL;
}

/** A tile of the terrain, `name` being `{floor}_{x}_{y}`; level 0 is the full size, 1 to 3 shrunk. */
export function terrainTileUrl(level, name) {
  return level === 0 ? `${mapBase()}/map/tiles/${name}.webp` : `${mapBase()}/map/zoom/${level}/${name}.webp`;
}

export function cantor(x, y) {
  return ((x + y) * (x + y + 1)) / 2 + y;
}

/** Per floor, the set of tiles there are, as the map numbers them, from `["x_y", ...]` lists. */
function tileSets(floors) {
  return (floors || []).map(
    (names) =>
      new Set(
        names.map((name) => {
          const [x, y] = name.split("_").map((part) => parseInt(part, 10));
          return cantor(x, y);
        }),
      ),
  );
}

/**
 * What the map needs from osrs-icons' data/map.json: which tiles there are, per floor and per
 * level; the icons and the labels keyed by map square; which labels name a region or a sea; and the
 * addresses of the icon sheet and of each label image.
 */
export function readMapData(published) {
  const base = mapBase();
  const labelFiles = published.labels?.files || [];
  return {
    tiles: tileSets(published.tiles),
    levels: Object.fromEntries(
      Object.entries(published.levels || {}).map(([level, floors]) => [level, tileSets(floors)]),
    ),
    icons: published.icons?.at || {},
    iconSheetUrl: published.icons?.sheet ? `${base}/map/${published.icons.sheet}` : null,
    labels: published.labels?.at || {},
    labelUrl: (id) => (labelFiles[id] ? `${base}/map/labels/${labelFiles[id]}.webp` : null),
    majorLabels: published.labels?.major || [],
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** The map's data and its links. The map works without links; it doesn't without its data. */
export async function loadMapData() {
  const [published, links] = await Promise.all([
    fetchJson(`${mapBase()}/data/map.json`),
    fetchJson("/data/map_links.json").catch((error) => {
      console.error("failed to load map links", error);
      return {};
    }),
  ]);
  return { ...readMapData(published), links };
}
