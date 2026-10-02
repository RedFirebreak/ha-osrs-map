// The time shown while trails are replayed: a point between the start and the
// end of the trails that can be dragged around or played, at a speed in trail
// seconds per real second.

// A frame that took longer than this (a hidden tab, a stall) counts as this long.
const MAX_FRAME_MS = 250;
// With idle time skipped: a wait longer than this is jumped over, up to this
// long before the next thing that happens.
const IDLE_SKIP_S = 600;
const IDLE_LEAD_S = 30;
// How long the replay stands still where a player landed after a hop, so the
// eye (and the camera) can catch up before it goes on.
const LANDING_HOLD_MS = 1500;
// How long a teleport that is played out takes, from the player vanishing to
// standing where they landed. The replay stands still for it instead.
const HOP_MS = 1300;

const DEFAULT_SPEED = 300;

export class ReplayClock {
  constructor() {
    this.tMin = 0;
    this.tMax = 0;
    this.time = 0;
    this.playing = false;
    this.speed = DEFAULT_SPEED;
    this.skipIdle = true;
    this.holdMs = 0;
    // The teleport being played out: `{leave, land, progress}`, the times the
    // player left and landed and how far it has got (0..1). Null when none is.
    this.hop = null;
    this.hopMs = 0;
  }

  get atEnd() {
    return this.time >= this.tMax;
  }

  /**
   * Sets the span of the trails. A clock at the end stays at the end, which is
   * "now" for a player who is online; any other time is kept if it still can be.
   */
  setRange(tMin, tMax) {
    const follow = this.atEnd;
    this.tMin = tMin;
    this.tMax = tMax;
    this.time = follow ? tMax : Math.min(Math.max(this.time, tMin), tMax);
  }

  seek(time) {
    this.time = Math.min(Math.max(time, this.tMin), this.tMax);
    this.holdMs = 0;
    this.hop = null;
  }

  /**
   * Starts playing: from the start when the end had been reached, and with
   * the teleport it was paused in, if any.
   */
  play() {
    if (this.atEnd && !this.hop) this.time = this.tMin;
    this.playing = true;
  }

  /**
   * Stops playing. A teleport that was being played out goes back to its
   * start and waits there: the time can't say that it has yet to happen when
   * the player left and landed in the same second.
   */
  pause() {
    this.playing = false;
    this.holdMs = 0;
    if (this.hop) this.hop = { ...this.hop, progress: 0 };
    this.hopMs = 0;
  }

  /**
   * Moves on by a frame that took `elapsedMs`. `nextChange(time)` says when
   * something next happens on the trails (null: nothing more), so that waits
   * can be skipped. `nextHop(from, to)` says where the player hops next,
   * landing after `from` and up to `to` (null: not in that span), as
   * `{leave, land, animated}`. An animated hop is played out: the clock stops
   * at `leave`, `hop` says how far it has got, and when it is over the clock
   * goes on from `land`. At any other the clock stops at `land` and stands
   * still for a moment. Returns whether there is something new to show: the
   * time changed, or a hop got further.
   */
  tick(elapsedMs, nextChange, nextHop) {
    if (!this.playing) return false;
    const frameMs = Math.min(elapsedMs, MAX_FRAME_MS);
    if (this.hop) {
      this.hopMs += frameMs;
      if (this.hopMs < HOP_MS) {
        this.hop = { ...this.hop, progress: this.hopMs / HOP_MS };
      } else {
        this.time = this.hop.land;
        this.hop = null;
        if (this.atEnd) this.playing = false;
      }
      return true;
    }
    if (this.holdMs > 0) {
      this.holdMs -= frameMs;
      return false;
    }
    const before = this.time;
    const next = this.skipIdle && nextChange ? nextChange(this.time) : undefined;
    if (next === null) {
      this.time = this.tMax;
    } else if (next !== undefined && next - this.time > IDLE_SKIP_S) {
      this.time = Math.min(next - IDLE_LEAD_S, this.tMax);
    } else {
      this.time = Math.min(this.time + (frameMs / 1000) * this.speed, this.tMax);
    }
    const hop = nextHop ? nextHop(before, this.time) : null;
    if (hop && hop.land > before && hop.land <= this.time) {
      if (hop.animated) {
        this.time = hop.leave;
        this.hop = { leave: hop.leave, land: hop.land, progress: 0 };
        this.hopMs = 0;
      } else {
        this.time = hop.land;
        this.holdMs = LANDING_HOLD_MS;
      }
    }
    if (this.atEnd && !this.hop) this.playing = false;
    return this.time !== before || Boolean(this.hop);
  }
}
