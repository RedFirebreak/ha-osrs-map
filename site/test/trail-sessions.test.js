import { describe, expect, it } from "vitest";
import { sessionOptions, spanKey, spanWindow } from "../src/map-page/trail-sessions";

// Monday 5 October 2026, 20:00 where the tests run.
const NOW = new Date(2026, 9, 5, 20, 0, 0).getTime();
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0);
const clock = (date) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (date) => date.toLocaleDateString([], { day: "numeric", month: "short" });

function session(start, end) {
  return {
    started_at: start.toISOString(),
    ended_at: end ? end.toISOString() : null,
    last_seen_at: (end || new Date(NOW)).toISOString(),
    duration_ms: (end ? end.getTime() : NOW) - start.getTime(),
    worlds: [302],
    end_reason: end ? "logout" : null,
  };
}

describe("sessionOptions", () => {
  it("says when a session was and how long, the day in words while that is clear", () => {
    const sessions = [
      session(at(5, 19, 5), null),
      session(at(5, 14, 10), at(5, 16, 32)),
      session(at(4, 20, 1), at(4, 23, 48)),
      session(at(2, 9, 0), at(2, 9, 30)),
    ];
    expect(sessionOptions(sessions, NOW).map((option) => option.label)).toEqual([
      `Now, since ${clock(at(5, 19, 5))}`,
      `Today ${clock(at(5, 14, 10))} to ${clock(at(5, 16, 32))}, 2h 22m`,
      `Yesterday ${clock(at(4, 20, 1))} to ${clock(at(4, 23, 48))}, 3h 47m`,
      `${day(at(2, 9, 0))} ${clock(at(2, 9, 0))} to ${clock(at(2, 9, 30))}, 30m`,
    ]);
  });

  it("gives a session a minute on both sides, and no end while it goes on", () => {
    const [open, over] = sessionOptions([session(at(5, 19, 5), null), session(at(5, 14, 10), at(5, 16, 32))], NOW);
    expect(open).toMatchObject({ from: at(5, 19, 5).getTime() / 1000 - 60, to: null });
    expect(over).toMatchObject({
      from: at(5, 14, 10).getTime() / 1000 - 60,
      to: at(5, 16, 32).getTime() / 1000 + 60,
    });
    // The value names the session by its start, which stays when it ends.
    expect(open.value).toBe(`session:${at(5, 19, 5).getTime()}`);
  });

  it("leaves out what is too short to have a trail, and keeps the newest twelve", () => {
    const blip = session(at(5, 18, 0), at(5, 18, 1));
    const many = Array.from({ length: 15 }, (_, i) => session(at(4, 23 - i, 0), at(4, 23 - i, 30)));
    const options = sessionOptions([blip, ...many], NOW);
    expect(options).toHaveLength(12);
    expect(options[0].value).toBe(`session:${at(4, 23, 0).getTime()}`);
  });

  it("leaves out a session too long to be asked for as one trail", () => {
    // A client that never logged out, or a hub that never closed the session.
    const stuck = session(new Date(NOW - 8 * 86400 * 1000), null);
    const week = session(new Date(NOW - 9 * 86400 * 1000), new Date(NOW - 2 * 86400 * 1000 + 1));
    const long = session(new Date(NOW - 6 * 86400 * 1000), null);
    const options = sessionOptions([stuck, long, week], NOW);
    expect(options.map((option) => option.start)).toEqual([NOW - 6 * 86400 * 1000]);
  });

  it("is empty for an answer without sessions", () => {
    expect(sessionOptions(undefined, NOW)).toEqual([]);
  });
});

describe("a span of trail", () => {
  it("is a number of days or from one moment to another", () => {
    expect(spanKey(7)).toBe("7");
    expect(spanKey({ from: 100, to: 200 })).toBe("100-200");
    expect(spanKey({ from: 100, to: null })).toBe("100-");
  });

  it("knows how long it is and whether it ends before now", () => {
    expect(spanWindow(7, 1000)).toEqual({ windowS: 7 * 86400, until: null });
    expect(spanWindow({ from: 100, to: 700 }, 1000)).toEqual({ windowS: 600, until: 700 });
    expect(spanWindow({ from: 100, to: null }, 1000)).toEqual({ windowS: 900, until: null });
  });
});
