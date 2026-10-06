import { clockTime, formatDuration, shortDay } from "../data/format";

// How long a trail is asked for: a number of days up to now, or the time of
// one of a player's play sessions, `{from, to}` in unix seconds. `to` is null
// while the session goes on.

// The hub dates a session by when it received a message and a point of a
// trail by the player's clock, so a session is asked for with a little to spare.
const SESSION_PAD_S = 60;
// Shorter than this there is no trail to speak of.
const SESSION_MIN_MS = 2 * 60 * 1000;
// A trail is 7 days at most (the server refuses more); with the minutes to
// spare, and some for a session that goes on while it is shown.
const SESSION_MAX_MS = 7 * 86400 * 1000 - 10 * 60 * 1000;
const SESSIONS_SHOWN = 12;
const DAY_MS = 86400 * 1000;

/** "Today", "Yesterday", or the day as elsewhere on the site ("3 Oct"). */
function dayName(time, nowMs) {
  const midnight = (ms) => new Date(ms).setHours(0, 0, 0, 0);
  const daysAgo = Math.round((midnight(nowMs) - midnight(time)) / DAY_MS);
  if (daysAgo === 0) return "Today";
  return daysAgo === 1 ? "Yesterday" : shortDay(time);
}

/**
 * A player's sessions (as /hub/players/.../sessions gives them, newest first)
 * as choices for the length of the trails: `[{value, label, start, from,
 * to}]`. `start` is when the session began (ms), which names it for as long
 * as it is listed; `from` and `to` are the span to ask for.
 */
export function sessionOptions(sessions, nowMs = Date.now()) {
  return (sessions || [])
    .map((session) => {
      const start = new Date(session.started_at).getTime();
      const end = session.ended_at ? new Date(session.ended_at).getTime() : null;
      return { start, end };
    })
    .filter(({ start, end }) => !isNaN(start) && (end === null || end - start >= SESSION_MIN_MS))
    .filter(({ start, end }) => (end ?? nowMs) - start <= SESSION_MAX_MS)
    .slice(0, SESSIONS_SHOWN)
    .map(({ start, end }) => ({
      value: `session:${start}`,
      label:
        end === null
          ? `Now, since ${clockTime(start)}`
          : `${dayName(start, nowMs)} ${clockTime(start)} to ${clockTime(end)}, ${formatDuration(end - start)}`,
      start,
      from: Math.floor(start / 1000) - SESSION_PAD_S,
      to: end === null ? null : Math.ceil(end / 1000) + SESSION_PAD_S,
    }));
}

/** A span as one word, to tell whether what was fetched is for it. */
export function spanKey(span) {
  return typeof span === "number" ? String(span) : `${span.from}-${span.to ?? ""}`;
}

/**
 * How a trail over a span is drawn: `windowS`, how long the span is at
 * `nowS`, and `until`, when it ended (null: it runs until now).
 */
export function spanWindow(span, nowS) {
  if (typeof span === "number") return { windowS: span * 86400, until: null };
  return { windowS: (span.to ?? nowS) - span.from, until: span.to ?? null };
}
