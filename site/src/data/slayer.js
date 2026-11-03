// The slayer task, points and streaks, as the hub passes them on from the plugin (hub D-141), in
// the member's meta as `slayer`: { task: { name, location, remaining, amount } | null, points,
// streaks: { normal, wilderness, mortimer } }.
import { el } from "../dom";
import { skillIconUrl } from "./icons";

const STREAK_LABELS = { normal: "Task streak", wilderness: "Wilderness streak", mortimer: "Mortimer streak" };

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * The member's slayer state, or null when the map doesn't know (a hub from before D-141, the plugin
 * never sent it, `activity` not shared). A task stays assigned while the player is offline.
 */
export function slayerState(member) {
  const slayer = member?.meta?.slayer;
  if (!slayer || typeof slayer !== "object") return null;
  const t = slayer.task;
  const remaining = count(t?.remaining);
  const streaks = slayer.streaks ?? {};
  return {
    task:
      t && remaining !== null && remaining > 0
        ? {
            name: typeof t.name === "string" && t.name ? t.name : null,
            location: typeof t.location === "string" && t.location ? t.location : null,
            remaining,
            amount: Math.max(count(t.amount) ?? remaining, remaining),
          }
        : null,
    points: count(slayer.points),
    streaks: {
      normal: count(streaks.normal),
      wilderness: count(streaks.wilderness),
      mortimer: count(streaks.mortimer),
    },
  };
}

/** The streak to show: the regular one while it runs, else the longest other one. */
export function mainStreak(state) {
  const sent = Object.entries(state.streaks).filter(([, value]) => value !== null);
  if (sent.length === 0) return null;
  if ((state.streaks.normal ?? 0) > 0) return { label: STREAK_LABELS.normal, value: state.streaks.normal };
  const [key, value] = sent.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { label: STREAK_LABELS[key], value };
}

/** "87 / 120 left", and how far the task is (0 … 1). */
export function taskProgress(task) {
  const done = Math.max(0, task.amount - task.remaining);
  return {
    text: `${task.remaining.toLocaleString()} / ${task.amount.toLocaleString()} left`,
    share: task.amount > 0 ? Math.min(1, done / task.amount) : 0,
  };
}

/** The profile's slayer block: the task with its bar, then points and the streak. */
export function slayerElement(state) {
  const box = el("div", "slayer");
  const head = el("div", "slayer__head");
  const url = skillIconUrl("Slayer");
  if (url) {
    const img = document.createElement("img");
    img.className = "slayer__icon";
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => img.remove());
    head.append(img);
  }
  const { task } = state;
  if (task === null) {
    head.append(el("span", "slayer__none", "No slayer task"));
    box.append(head);
  } else {
    const name = el("span", "slayer__task", task.name ?? "Unknown task");
    if (task.location) name.append(el("span", "slayer__location", ` · ${task.location}`));
    const progress = taskProgress(task);
    head.append(name, el("span", "slayer__left", progress.text));
    const bar = el("div", "slayer__bar");
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", "Slayer task");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(task.amount));
    bar.setAttribute("aria-valuenow", String(task.amount - task.remaining));
    const fill = el("div", "slayer__fill");
    fill.style.width = `${Math.round(progress.share * 100)}%`;
    bar.append(fill);
    box.append(head, bar);
  }
  const numbers = [];
  if (state.points !== null) numbers.push(`${state.points.toLocaleString()} points`);
  const streak = mainStreak(state);
  if (streak) numbers.push(`${streak.label} ${streak.value.toLocaleString()}`);
  if (numbers.length > 0) box.append(el("div", "slayer__numbers", numbers.join(" · ")));
  return box;
}
