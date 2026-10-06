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

  it("names the day a session ended on too, once it lasted a day or longer", () => {
    const september = (date, hour, minute = 0) => new Date(2026, 8, date, hour, minute, 0);
    const sessions = [
      // Until an hour and a half ago, from yesterday.
      session(at(4, 19, 0), at(5, 19, 30)),
      session(at(2, 22, 28), at(4, 1, 0)),
      session(september(29, 10, 0), at(2, 11, 24)),
      // A day to the minute, and a minute less: of that one the length says enough.
      session(september(28, 8, 0), september(29, 8, 0)),
      session(september(27, 8, 0), september(28, 7, 59)),
    ];
    expect(sessionOptions(sessions, NOW).map((option) => option.label)).toEqual([
      `Yesterday ${clock(at(4, 19, 0))} to Today ${clock(at(5, 19, 30))}, 1d 0h`,
      `${day(at(2, 22, 28))} ${clock(at(2, 22, 28))} to Yesterday ${clock(at(4, 1, 0))}, 1d 2h`,
      `${day(september(29, 10))} ${clock(september(29, 10))} to ${day(at(2, 11, 24))} ${clock(at(2, 11, 24))}, 3d 1h`,
      `${day(september(28, 8))} ${clock(september(28, 8))} to ${day(september(29, 8))} ${clock(september(29, 8))}, 1d 0h`,
      `${day(september(27, 8))} ${clock(september(27, 8))} to ${clock(september(28, 7, 59))}, 23h 59m`,
    ]);
  });

  it("says the day a session that still goes on began, unless that is today", () => {
    const labels = (sessions) => sessionOptions(sessions, NOW).map((option) => option.label);
    expect(labels([session(at(5, 19, 5), null)])).toEqual([`Now, since ${clock(at(5, 19, 5))}`]);
    expect(labels([session(at(4, 23, 42), null)])).toEqual([`Now, since yesterday ${clock(at(4, 23, 42))}`]);
    expect(labels([session(at(2, 22, 28), null)])).toEqual([
      `Now, since ${day(at(2, 22, 28))} ${clock(at(2, 22, 28))}`,
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

  it("keeps the session that was picked in the list, also as a thirteenth", () => {
    const many = Array.from({ length: 15 }, (_, i) => session(at(4, 23 - i, 0), at(4, 23 - i, 30)));
    const start = (index) => at(4, 23 - index, 0).getTime();
    const twelve = sessionOptions(many, NOW);
    // The fourteenth was picked; twelve newer ones have come since.
    const options = sessionOptions(many, NOW, start(13));
    expect(options).toHaveLength(13);
    expect(options.slice(0, 12)).toEqual(twelve);
    expect(options[12]).toMatchObject({ start: start(13), value: `session:${start(13)}` });
    // One of the twelve is there once.
    expect(sessionOptions(many, NOW, start(3))).toEqual(twelve);
    // What the list never had isn't kept for being picked: too short, or no session of this player's.
    const blip = session(at(3, 18, 0), at(3, 18, 1));
    expect(sessionOptions([...many, blip], NOW, at(3, 18, 0).getTime())).toEqual(twelve);
    expect(sessionOptions(many, NOW, 12345)).toEqual(twelve);
  });

  it("drops the session that was picked like any other once it is too long to ask for", () => {
    const stuck = session(new Date(NOW - 8 * 86400 * 1000), null);
    expect(sessionOptions([stuck], NOW, NOW - 8 * 86400 * 1000)).toEqual([]);
  });

  it("leaves out a session too long to be asked for as one trail", () => {
    // A client that never stops sending: the hub keeps its session open.
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

  it("knows how long it is, whether it ends before now and when it began", () => {
    // A number of days ends now, and began that many days before now.
    const now = 1_790_000_000;
    expect(spanWindow(7, now)).toEqual({ windowS: 7 * 86400, until: null, from: now - 7 * 86400 });
    expect(spanWindow({ from: 100, to: 700 }, 1000)).toEqual({ windowS: 600, until: 700, from: 100 });
    expect(spanWindow({ from: 100, to: null }, 1000)).toEqual({ windowS: 900, until: null, from: 100 });
  });
});
