// Run energy, special attack, poison, the wilderness level and the running effects, as the hub passes
// them on from the plugin (hub D-143), in the member's meta as `status`: { run_energy, running,
// special_attack, poison: { type, damage }, wilderness_level, effects: [{ id, name, ends_at,
// precision_ms }] }. Offline the hub sends no effects, no poison and no wilderness level.
import { el } from "../dom";
import { itemIconUrl } from "./icons";

/** The item whose picture stands for an effect: the 4-dose potion RuneLite's Timers & Buffs shows. */
export const EFFECT_ITEMS = {
  stamina: 12625,
  antifire: 2452,
  superantifire: 21978,
  antipoison: 2446,
  antivenom: 12905,
  divine_super_attack: 23697,
  divine_super_strength: 23709,
  divine_super_defence: 23721,
  divine_ranging: 23733,
  divine_magic: 23745,
  divine_super_combat: 23685,
  divine_bastion: 24635,
  divine_battlemage: 24623,
  moonlight_potion: 29080,
  goading: 30137,
  prayer_regeneration: 30125,
  surge_potion: 30875,
  menaphite_remedy: 27202,
  imbuedheart: 20724,
  overload: 11730,
};

const percent = (value) => (Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : null);

/**
 * The member's status, or null when the map doesn't know (a hub from before D-143, the plugin never
 * sent it, `activity` not shared).
 */
export function statusState(member) {
  const s = member?.meta?.status;
  if (!s || typeof s !== "object") return null;
  const runEnergy = percent(s.run_energy);
  const specialAttack = percent(s.special_attack);
  if (runEnergy === null || specialAttack === null) return null;
  const type = ["poison", "venom"].includes(s.poison?.type) ? s.poison.type : "none";
  const level = Number.isSafeInteger(s.wilderness_level) && s.wilderness_level > 0 ? s.wilderness_level : null;
  return {
    runEnergy,
    running: s.running === true,
    specialAttack,
    poison: { type, damage: type === "none" ? null : (s.poison?.damage ?? null) },
    wildernessLevel: level,
    effects: (Array.isArray(s.effects) ? s.effects : [])
      .map((e) => ({
        id: String(e?.id ?? ""),
        name: typeof e?.name === "string" && e.name ? e.name : String(e?.id ?? ""),
        endsAt: Date.parse(e?.ends_at),
        precision: Number.isFinite(e?.precision_ms) ? e.precision_ms : 0,
      }))
      .filter((e) => e.id && Number.isFinite(e.endsAt)),
  };
}

/** The time an effect has left, rounded down: "1:02:03", "4:05", "0:09". Never negative. */
export function formatLeft(endsAt, now) {
  const total = Math.max(0, Math.floor((endsAt - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What an effect card says on hover: its name, the time left, when it ends and how exact that is. */
export function effectTitle(effect, now) {
  const ends = new Date(effect.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const exact = effect.precision <= 600 ? "to the tick" : `to within ${Math.round(effect.precision / 1000)} seconds`;
  return `${effect.name}\n${formatLeft(effect.endsAt, now)} left, ends ${ends}\nExact ${exact}`;
}

/** A round gauge like the game's minimap orbs. */
function orb(label, value, color) {
  const box = el("div", "status-orb");
  box.style.setProperty("--orb-color", color);
  box.style.setProperty("--orb-share", `${value}%`);
  box.setAttribute("role", "meter");
  box.setAttribute("aria-label", label);
  box.setAttribute("aria-valuemin", "0");
  box.setAttribute("aria-valuemax", "100");
  box.setAttribute("aria-valuenow", String(value));
  box.append(el("span", "status-orb__value", String(value)), el("span", "status-orb__label", label));
  return box;
}

/** The profile's status block: run and special orbs, then poison and the wilderness as badges. */
export function statusElement(state) {
  const box = el("div", "status");
  const orbs = el("div", "status__orbs");
  orbs.append(
    orb(state.running ? "Run" : "Walk", state.runEnergy, "#d9a400"),
    orb("Special", state.specialAttack, "#2b9fc4"),
  );
  box.append(orbs);
  const badges = el("div", "status__badges");
  if (state.poison.type !== "none") {
    const text = state.poison.type === "venom" ? "Venomed" : "Poisoned";
    badges.append(
      el(
        "span",
        `status__badge status__badge--${state.poison.type}`,
        state.poison.damage === null ? text : `${text} · ${state.poison.damage}`,
      ),
    );
  }
  if (state.wildernessLevel !== null) {
    badges.append(el("span", "status__badge status__badge--wilderness", `Wilderness level ${state.wildernessLevel}`));
  }
  if (badges.childElementCount > 0) box.append(badges);
  return box;
}

/**
 * The running effects as icon cards with the time left; the rest on hover. Returns the list and a
 * `tick(now)` that counts the cards down and drops the ones that ended.
 */
export function effectsElement(state, now = Date.now()) {
  const list = el("ul", "status__effects");
  list.setAttribute("aria-label", "Effects");
  const cards = state.effects.map((effect) => {
    const card = el("li", "status__effect");
    card.tabIndex = 0;
    const url = EFFECT_ITEMS[effect.id] ? itemIconUrl(EFFECT_ITEMS[effect.id]) : "";
    if (url) {
      const img = document.createElement("img");
      img.className = "status__effect-icon";
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () =>
        img.replaceWith(el("span", "status__effect-icon status__effect-icon--none", "⏱")),
      );
      card.append(img);
    } else {
      card.append(el("span", "status__effect-icon status__effect-icon--none", "⏱"));
    }
    const left = el("span", "status__effect-left");
    card.append(left);
    return { effect, card, left };
  });
  const tick = (at) => {
    const running = cards.filter((c) => c.effect.endsAt > at);
    for (const c of cards) if (c.effect.endsAt <= at) c.card.remove();
    for (const { effect, card, left } of running) {
      left.textContent = formatLeft(effect.endsAt, at);
      card.title = effectTitle(effect, at);
      card.setAttribute("aria-label", card.title.replaceAll("\n", ", "));
    }
    return running.length;
  };
  list.append(...cards.map((c) => c.card));
  tick(now);
  return { list, tick };
}
