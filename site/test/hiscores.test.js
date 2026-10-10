import { describe, expect, it } from "vitest";
import { activityLabel, guildBoard, guildBoards, hiscoresView } from "../src/data/hiscores";

// One account as the hub's GET /accounts/{id}/hiscores gives it (its hiscores/api.md).
const IRON = {
  status: "ok",
  fetched_at: "2026-10-09T21:40:00.000Z",
  mode: "ironman",
  skills: [
    { skill: "Overall", level: 2277, xp: 312000000, rank: 91000, mode_rank: 4100 },
    { skill: "Attack", level: 99, xp: 13034431, rank: 120000, mode_rank: 5100 },
    { skill: "Sailing", level: 1, xp: null, rank: null, mode_rank: null },
  ],
  activities: [
    { activity: "Clue Scrolls (all)", kind: "clue", score: 340, rank: 50000, mode_rank: null },
    { activity: "Clue Scrolls (hard)", kind: "clue", score: 12, rank: 90000, mode_rank: null },
    { activity: "Clue Scrolls (master)", kind: "clue", score: 20, rank: 9000, mode_rank: null },
    { activity: "Collections Logged", kind: "activity", score: 812, rank: 30000, mode_rank: 2500 },
    { activity: "Vorkath", kind: "boss", score: 40, rank: 90000, mode_rank: 3000 },
    { activity: "Zulrah", kind: "boss", score: 512, rank: 12000, mode_rank: 800 },
    { activity: "A boss from next week", kind: "raid", score: 9, rank: 1, mode_rank: null },
  ],
};

describe("a player's hiscores in the profile", () => {
  it("keeps the skills in Jagex's order, with the rank on the account's own table", () => {
    const view = hiscoresView(IRON);
    expect(view.modeTable).toBe("Ironman");
    expect(view.skills.map((skill) => skill.name)).toEqual(["Overall", "Attack", "Sailing"]);
    expect(view.skills[1]).toEqual({ name: "Attack", level: 99, xp: 13034431, rank: 120000, modeRank: 5100 });
    expect(view.skills[2]).toEqual({ name: "Sailing", level: 1, xp: null, rank: null, modeRank: null });
  });

  it("splits the activities into bosses, clues and the rest, bosses and the rest most first", () => {
    const view = hiscoresView(IRON);
    expect(view.bosses.map((boss) => [boss.name, boss.score])).toEqual([
      ["Zulrah", 512],
      ["Vorkath", 40],
    ]);
    expect(view.clues.map((clue) => clue.name)).toEqual([
      "Clue Scrolls (all)",
      "Clue Scrolls (hard)",
      "Clue Scrolls (master)",
    ]);
    // A kind this site doesn't know goes with the rest rather than nowhere.
    expect(view.activities.map((activity) => activity.name)).toEqual(["Collections Logged", "A boss from next week"]);
  });

  it("takes Jagex's -1 and a score of 0 for not listed", () => {
    const view = hiscoresView({
      status: "ok",
      fetched_at: "2026-10-09T21:40:00.000Z",
      mode: "regular",
      skills: [{ skill: "Attack", level: -1, xp: -1, rank: -1, mode_rank: null }],
      activities: [
        { activity: "Zulrah", kind: "boss", score: -1, rank: -1 },
        { activity: "Vorkath", kind: "boss", score: 0, rank: 5 },
      ],
    });
    expect(view.modeTable).toBeNull();
    expect(view.skills[0]).toEqual({ name: "Attack", level: null, xp: null, rank: null, modeRank: null });
    expect(view.bosses).toEqual([]);
  });

  it("tells an account the hub hasn't read from one it has", () => {
    expect(hiscoresView({ status: "pending", fetched_at: null, skills: [], activities: [] })).toMatchObject({
      status: "pending",
      fetchedAt: null,
    });
    expect(hiscoresView({ ...IRON, status: "not_found" })).toMatchObject({
      status: "not_found",
      fetchedAt: IRON.fetched_at,
    });
  });

  it("names a clue tier by its tier", () => {
    expect(activityLabel("Clue Scrolls (elite)")).toBe("Elite");
    expect(activityLabel("Clue Scrolls (all)")).toBe("All");
    expect(activityLabel("TzKal-Zuk")).toBe("TzKal-Zuk");
  });
});

describe("the guild's hiscores", () => {
  const players = [
    { name: "Alpha", ...IRON },
    {
      name: "Bravo",
      skills: [
        { skill: "Overall", level: 1500, xp: 40000000, rank: 300000 },
        { skill: "Attack", level: 99, xp: 14000000, rank: 100000 },
      ],
      activities: [{ activity: "Zulrah", kind: "boss", score: 600, rank: 10000 }],
    },
    { name: "Charlie", skills: [{ skill: "Overall", level: 32, xp: null, rank: null }], activities: [] },
  ];

  it("offers every skill, then what anyone has a score in", () => {
    expect(guildBoards(players)).toEqual([
      {
        group: "Skills",
        options: [
          { key: "skill:Overall", label: "Overall" },
          { key: "skill:Attack", label: "Attack" },
          { key: "skill:Sailing", label: "Sailing" },
        ],
      },
      {
        group: "Bosses",
        options: [
          { key: "activity:Vorkath", label: "Vorkath" },
          { key: "activity:Zulrah", label: "Zulrah" },
        ],
      },
      {
        group: "Clue scrolls",
        options: [
          { key: "activity:Clue Scrolls (all)", label: "All" },
          { key: "activity:Clue Scrolls (hard)", label: "Hard" },
          { key: "activity:Clue Scrolls (master)", label: "Master" },
        ],
      },
      {
        group: "Other activities",
        options: [
          { key: "activity:A boss from next week", label: "A boss from next week" },
          { key: "activity:Collections Logged", label: "Collections Logged" },
        ],
      },
    ]);
  });

  it("ranks a skill by XP, with a level but no XP last", () => {
    expect(guildBoard(players, "skill:Overall")).toEqual([
      { name: "Alpha", level: 2277, xp: 312000000 },
      { name: "Bravo", level: 1500, xp: 40000000 },
      { name: "Charlie", level: 32, xp: null },
    ]);
    expect(guildBoard(players, "skill:Attack").map((entry) => entry.name)).toEqual(["Bravo", "Alpha"]);
  });

  it("ranks an activity by score, leaving out who has none", () => {
    expect(guildBoard(players, "activity:Zulrah")).toEqual([
      { name: "Bravo", score: 600 },
      { name: "Alpha", score: 512 },
    ]);
    expect(guildBoard(players, "activity:Vorkath")).toEqual([{ name: "Alpha", score: 40 }]);
  });
});
