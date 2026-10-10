// The official hiscores as the hub passes them on (`api.getPlayerHiscores`,
// the hub's GET /accounts/{id}/hiscores): what the profile's Hiscores tab
// shows of them, and in which groups.

const MODE_TABLES = {
  ironman: "Ironman",
  hardcore_ironman: "Hardcore Ironman",
  ultimate_ironman: "Ultimate Ironman",
};

/** A number the hiscores list: 0 or more. `null` and Jagex's -1 are "not listed". */
function listed(value) {
  return typeof value === "number" && value >= 0 ? value : null;
}

/** A rank starts at 1. */
function rank(value) {
  const listedRank = listed(value);
  return listedRank ? listedRank : null;
}

/**
 * The hub's answer as the tab shows it. Skills keep Jagex's order (Overall
 * first). Activities with a score are split into bosses, clue scrolls and the
 * rest; bosses and the rest most first. `modeTable` names an iron account's own table, which
 * `modeRank` is the rank on.
 */
export function hiscoresView(data) {
  const skills = (data?.skills || []).map((entry) => ({
    name: entry.skill,
    level: listed(entry.level),
    xp: listed(entry.xp),
    rank: rank(entry.rank),
    modeRank: rank(entry.mode_rank),
  }));

  const groups = { boss: [], clue: [], activity: [] };
  for (const entry of data?.activities || []) {
    const score = listed(entry.score);
    if (!score) continue;
    // A kind this site doesn't know yet is shown with the rest.
    const group = groups[entry.kind] || groups.activity;
    group.push({
      name: entry.activity,
      score,
      rank: rank(entry.rank),
      modeRank: rank(entry.mode_rank),
    });
  }
  // Clue tiers keep Jagex's order (all, then beginner to master).
  for (const list of [groups.boss, groups.activity]) list.sort((a, b) => b.score - a.score);

  return {
    status: data?.status || "pending",
    fetchedAt: data?.fetched_at || null,
    modeTable: MODE_TABLES[data?.mode] || null,
    skills,
    bosses: groups.boss,
    clues: groups.clue,
    activities: groups.activity,
  };
}

/** "Clue Scrolls (elite)" → "Elite"; other names as Jagex writes them. */
export function activityLabel(name) {
  const clue = /^Clue Scrolls \((.+)\)$/.exec(name);
  if (!clue) return name;
  return clue[1].charAt(0).toUpperCase() + clue[1].slice(1);
}

const CLUE_TIERS = ["all", "beginner", "easy", "medium", "hard", "elite", "master"];

/** Clue tiers in Jagex's order; a tier this site doesn't know goes last. */
function byTier(a, b) {
  const tier = (name) => {
    const index = CLUE_TIERS.indexOf(activityLabel(name).toLowerCase());
    return index === -1 ? CLUE_TIERS.length : index;
  };
  return tier(a) - tier(b) || a.localeCompare(b);
}

const GROUPS = [
  ["boss", "Bosses"],
  ["clue", "Clue scrolls"],
  ["activity", "Other activities"],
];

/**
 * What the guild can be ranked on (`/api/hub/hiscores`): every skill, then
 * the bosses, clue tiers and other activities that anyone has a score in,
 * as `{group, options: [{key, label}]}`.
 */
export function guildBoards(players) {
  const skills = [];
  const activities = new Map(GROUPS.map(([kind]) => [kind, new Set()]));
  for (const player of players) {
    for (const entry of player.skills || []) {
      if (!skills.includes(entry.skill)) skills.push(entry.skill);
    }
    for (const entry of player.activities || []) {
      if (!listed(entry.score)) continue;
      (activities.get(entry.kind) || activities.get("activity")).add(entry.activity);
    }
  }
  const boards = [];
  if (skills.length) {
    boards.push({ group: "Skills", options: skills.map((skill) => ({ key: `skill:${skill}`, label: skill })) });
  }
  for (const [kind, group] of GROUPS) {
    const names = [...activities.get(kind)].sort(kind === "clue" ? byTier : (a, b) => a.localeCompare(b));
    if (names.length) {
      boards.push({ group, options: names.map((name) => ({ key: `activity:${name}`, label: activityLabel(name) })) });
    }
  }
  return boards;
}

/**
 * The guild ranked on the board `key` (from guildBoards), best first: a
 * skill by XP, an activity by score. Players the hiscores don't list for it
 * are left out. Each entry is `{name, level, xp}` or `{name, score}`.
 */
export function guildBoard(players, key) {
  const [type, ...rest] = key.split(":");
  const name = rest.join(":");
  const entries = [];
  for (const player of players) {
    if (type === "skill") {
      const entry = (player.skills || []).find((skill) => skill.skill === name);
      const xp = listed(entry?.xp);
      const level = listed(entry?.level);
      if (xp === null && level === null) continue;
      entries.push({ name: player.name, level, xp });
    } else {
      const entry = (player.activities || []).find((activity) => activity.activity === name);
      const score = listed(entry?.score);
      if (!score) continue;
      entries.push({ name: player.name, score });
    }
  }
  const value = (entry) => (type === "skill" ? [entry.xp ?? -1, entry.level ?? -1] : [entry.score, 0]);
  entries.sort((a, b) => {
    const [a1, a2] = value(a);
    const [b1, b2] = value(b);
    return b1 - a1 || b2 - a2 || a.name.localeCompare(b.name);
  });
  return entries;
}
