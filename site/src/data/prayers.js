// The prayers a player has on, as the hub passes them on from the plugin (hub D-119): RuneLite
// Prayer names in prayer book order, in the member's meta as `active_prayers`.
import { el } from "../dom";
import { prayerIconUrl } from "./icons";

// Ruinous Powers whose in-game name has an apostrophe.
const SPECIAL_LABELS = {
  RP_FUMUS_VOW: "Fumus' Vow",
  RP_UMBRA_VOW: "Umbra's Vow",
  RP_CRUORS_VOW: "Cruor's Vow",
  RP_GLACIES_VOW: "Glacies' Vow",
};
const LOWERCASE_WORDS = new Set(["of", "from"]);

/** PROTECT_FROM_MISSILES → "Protect from Missiles", RP_TRINITAS → "Trinitas". */
export function prayerLabel(name) {
  if (SPECIAL_LABELS[name]) return SPECIAL_LABELS[name];
  return String(name)
    .replace(/^RP_/, "")
    .split("_")
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLowerCase();
      return i > 0 && LOWERCASE_WORDS.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * The prayers `member` has on: an array (empty when none is on), or null when the map doesn't know
 * (a hub from before D-119, activity not shared). Offline players have none on.
 */
export function activePrayers(member) {
  const prayers = member?.meta?.active_prayers;
  if (!Array.isArray(prayers)) return null;
  return member.online ? prayers.filter((name) => typeof name === "string") : [];
}

/**
 * One prayer as an element: its icon, or its name when there is no icon (icons off, or the icon set
 * has none yet). `withLabel` puts the name beside the icon too.
 */
export function prayerElement(name, { withLabel = false } = {}) {
  const label = prayerLabel(name);
  const item = el("span", "prayer");
  item.title = label;
  const url = prayerIconUrl(name);
  const text = el("span", "prayer__label", label);
  if (url) {
    const img = document.createElement("img");
    img.className = "prayer__icon";
    img.src = url;
    img.alt = withLabel ? "" : label;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove();
      if (!withLabel) item.append(text);
    });
    item.append(img);
    if (withLabel) item.append(text);
  } else {
    item.append(text);
  }
  return item;
}
