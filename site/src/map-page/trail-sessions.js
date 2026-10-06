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
 * "Today 14:10 to 16:32, 2h 22m": when a session that is over was, and how
 * long. One of a day or longer names the day it ended on as well: without it
 * "2 Oct 22:28 to 23:24, 3d 0h" reads as an hour of one evening.
 */
function sessionLabel(start, end, nowMs) {
  const ended = end - start >= DAY_MS ? `${dayName(end, nowMs)} ${clockTime(end)}` : clockTime(end);
  return `${dayName(start, nowMs)} ${clockTime(start)} to ${ended}, ${formatDuration(end - start)}`;
}

/**
 * A player's sessions (as /hub/players/.../sessions gives them, newest first)
 * as choices for the length of the trails: `[{value, label, start, from,
 * to}]`. `start` is when the session began (ms), which names it for as long
 * as it is listed; `from` and `to` are the span to ask for. The newest twelve
 * are listed, and after them the one that was picked (`picked`, its `start`)
 * when it is older than those: it only goes when it is no session to ask
 * for any more.
 */
export function sessionOptions(sessions, nowMs = Date.now(), picked = null) {
  return (sessions || [])
    .map((session) => {
      const start = new Date(session.started_at).getTime();
      const end = session.ended_at ? new Date(session.ended_at).getTime() : null;
      return { start, end };
    })
    .filter(({ start, end }) => !isNaN(start) && (end === null || end - start >= SESSION_MIN_MS))
    .filter(({ start, end }) => (end ?? nowMs) - start <= SESSION_MAX_MS)
    .filter(({ start }, index) => index < SESSIONS_SHOWN || start === picked)
    .map(({ start, end }) => ({
      value: `session:${start}`,
      label: end === null ? `Now, since ${clockTime(start)}` : sessionLabel(start, end, nowMs),
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
 * `nowS`; `until`, when it ended (null: it runs until now); and `from`, when
 * it began (null for a number of days, which slides along with now).
 */
export function spanWindow(span, nowS) {
  if (typeof span === "number") return { windowS: span * 86400, until: null, from: null };
  return { windowS: (span.to ?? nowS) - span.from, until: span.to ?? null, from: span.from };
}
