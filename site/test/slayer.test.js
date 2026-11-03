import { describe, expect, it } from "vitest";
import { mainStreak, slayerElement, slayerState, taskProgress } from "../src/data/slayer";

const meta = {
  slayer: {
    task: { name: "Wyrms", location: "Karuulm Slayer Dungeon", remaining: 30, amount: 120 },
    points: 1234,
    streaks: { normal: 99, wilderness: 12, mortimer: 5 },
  },
};

describe("slayerState", () => {
  it("is what the hub sends, offline too: a task stays assigned", () => {
    expect(slayerState({ online: false, meta })).toEqual(meta.slayer);
  });

  it("has no task between tasks, or with none left", () => {
    const between = { slayer: { ...meta.slayer, task: null } };
    expect(slayerState({ meta: between }).task).toBeNull();
    const done = { slayer: { ...meta.slayer, task: { ...meta.slayer.task, remaining: 0 } } };
    expect(slayerState({ meta: done }).task).toBeNull();
  });

  it("is unknown without the field (an older hub, activity not shared)", () => {
    expect(slayerState({ meta: {} })).toBeNull();
    expect(slayerState({})).toBeNull();
    expect(slayerState(undefined)).toBeNull();
  });
});

describe("mainStreak and taskProgress", () => {
  it("shows the regular streak while it runs, else the longest other one", () => {
    expect(mainStreak(slayerState({ meta }))).toEqual({ label: "Task streak", value: 99 });
    const wildy = { slayer: { ...meta.slayer, streaks: { normal: 0, wilderness: 12, mortimer: 5 } } };
    expect(mainStreak(slayerState({ meta: wildy }))).toEqual({ label: "Wilderness streak", value: 12 });
  });

  it("says how many are left and how far the task is", () => {
    expect(taskProgress(meta.slayer.task)).toEqual({ text: "30 / 120 left", share: 0.75 });
  });
});

describe("slayerElement", () => {
  it("draws the task with its area, the bar, the points and the streak", () => {
    const box = slayerElement(slayerState({ meta }));
    expect(box.querySelector(".slayer__task").textContent).toBe("Wyrms · Karuulm Slayer Dungeon");
    expect(box.querySelector(".slayer__left").textContent).toBe("30 / 120 left");
    expect(box.querySelector(".slayer__fill").style.width).toBe("75%");
    expect(box.querySelector(".slayer__numbers").textContent).toBe("1,234 points · Task streak 99");
  });

  it("says when there is no task", () => {
    const box = slayerElement(slayerState({ meta: { slayer: { ...meta.slayer, task: null } } }));
    expect(box.querySelector(".slayer__none").textContent).toBe("No slayer task");
    expect(box.querySelector(".slayer__bar")).toBeNull();
  });
});
