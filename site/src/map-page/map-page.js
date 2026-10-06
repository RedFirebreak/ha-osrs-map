import { BaseElement } from "../base-element/base-element";
import { api } from "../data/api";
import { selection } from "../data/selection";
import { newsTracker } from "../data/live-events";
import { colorForName } from "../data/player-colors";
import {
  EVENT_KINDS,
  MIN_LOOT_OPTIONS,
  eventIsFresh,
  eventPasses,
  loadEventFilters,
  saveEventFilters,
} from "../data/event-view";
import { clockTime, shortDay } from "../data/format";
import { remember, remembered } from "../data/storage";
import { sessionOptions, spanKey, spanWindow } from "./trail-sessions";
// The page drives these two from the moment it is connected, so they have to
// be defined before it is.
import "../canvas-map/canvas-map";
import "../trail-scrubber/trail-scrubber";
import "../event-toasts/event-toasts";

const TRAIL_REFRESH_MS = 60000;
// The first retry after a failed trail request; it doubles up to the normal refresh.
const TRAIL_RETRY_MS = 5000;
// Hub data older than this is the server's stale copy: the hub isn't answering.
const TRAIL_STALE_S = 180;
const TRAIL_DAYS_KEY = "map-trail-days";
// The sessions offered as the time of the trails: how far back they go, and
// how long a player's are taken as known. One that goes on ends some time.
const SESSIONS_DAYS = 7;
const SESSIONS_REFRESH_MS = 60000;
// A player's events over the length of their trail, to mark on it. What
// happened doesn't change, and what happens next comes with the live feed, so
// they are only asked for again now and then.
const TRAIL_EVENTS_REFRESH_MS = 10 * 60 * 1000;

/** "Hub data from 14:05" when `asOf` (unix seconds) is too long ago, else null. */
function staleNotice(asOf) {
  if (!asOf || Date.now() / 1000 - asOf < TRAIL_STALE_S) return null;
  return `Hub data from ${clockTime(asOf * 1000)}`;
}

// A trail that starts within this is said to start at a time, not only on a day.
const TRAIL_START_TIME_MS = 2 * 86400 * 1000;

/**
 * When a trail (as the server sends it) starts: "26 Sep", and "5 Oct 14:10"
 * when that is so lately that the day alone says little. Of a trail over a
 * play session (`ofSession`) the day alone never says much, however long ago:
 * it is the day the session was on.
 */
function trailStart(trail, ofSession) {
  const [, , , time, dwell = 0] = trail.points[0];
  const start = (time - dwell) * 1000;
  const day = shortDay(start);
  return ofSession || Date.now() - start < TRAIL_START_TIME_MS ? `${day} ${clockTime(start)}` : day;
}

/** The trail length chosen last time, when the select still offers it; else its first. */
function storedTrailDays(select) {
  const stored = String(remembered(TRAIL_DAYS_KEY));
  return [...select.options].some((option) => option.value === stored) ? stored : select.options[0].value;
}

export class MapPage extends BaseElement {
  constructor() {
    super();
    this.filters = loadEventFilters();
    // The trails as the server last gave them, and whether that was over a
    // play session and not a number of days.
    this.trailData = new Map();
    this.trailDataOfSession = false;
    this.trailEvents = new Map();
    this.liveEvents = [];
    // The sessions in the menu (see sessionOptions), whose they are and when
    // they were asked for; and the one that was picked, with its player.
    this.sessionChoices = [];
    this.sessionsOf = null;
    this.sessionsAt = 0;
    this.pickedSession = null;
    // Whose sessions the menu has, or is getting: the last player they were
    // asked for (see loadSessions).
    this.sessionsWanted = null;
  }

  html() {
    return `{{map-page.html}}`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.render();
    this.worldMap = document.querySelector("#background-worldmap");
    document.querySelector(".authed-section").classList.add("no-pointer-events");
    this.worldMap.classList.add("interactable");
    this.planeSelect = this.querySelector(".map-page__plane-select");
    this.trailControls = this.querySelector(".map-page__trails");
    this.trailChips = this.querySelector(".map-page__trail-chips");
    this.trailDaysSelect = this.querySelector(".map-page__trail-days");
    this.replayButton = this.querySelector(".map-page__trails-replay");
    this.scrubber = this.querySelector("trail-scrubber");
    this.eventControls = this.querySelector(".map-page__events");
    this.toasts = this.querySelector("event-toasts");

    this.planeSelect.value = this.worldMap.plane || 1;
    this.trailDaysSelect.value = storedTrailDays(this.trailDaysSelect);
    this.renderEventControls();
    this.worldMap.setEventFilters(this.filters);
    this.scrubber.nextChange = (time) => this.worldMap.trailNextChange(time);
    this.scrubber.nextHop = (from, to) => this.worldMap.trailNextHop(from, to);

    this.eventListener(this.planeSelect, "change", this.handlePlaneSelect.bind(this));
    this.eventListener(this.planeSelect, "wheel", this.handlePlaneWheel.bind(this), { passive: false });
    this.eventListener(this.worldMap, "plane-changed", this.handlePlaneChange.bind(this));
    this.eventListener(this.trailDaysSelect, "change", this.handleTrailDaysChange.bind(this));
    this.eventListener(this.trailChips, "click", this.handleTrailChipClick.bind(this));
    this.eventListener(this.replayButton, "click", this.handleReplayClick.bind(this));
    this.eventListener(this.scrubber, "replay-change", this.handleReplayChange.bind(this));
    this.eventListener(this.worldMap, "trail-timeline-changed", () =>
      this.scrubber.setTimeline(this.worldMap.trailTimeline()),
    );
    // The replay follows the player until the map is moved by hand.
    this.eventListener(this.worldMap, "map-dragged", () => this.scrubber.setFollow(false));
    this.eventListener(this.querySelector(".map-page__trails-clear"), "click", () => selection.clearTrails());
    this.eventListener(this.querySelector(".map-page__roster-toggle"), "click", () =>
      document.body.classList.toggle("roster-open"),
    );
    this.eventListener(this.eventControls, "change", this.handleEventFilterChange.bind(this));
    this.eventListener(this.toasts, "toast-activated", (event) => this.worldMap.goToEvent(event.detail.event));
    this.subscribe("features", this.handleFeatures.bind(this));
    this.subscribe("trails-changed", () => this.loadTrails());
    this.liveEventsBringNews = newsTracker();
    this.subscribe("live-events", this.handleLiveEvents.bind(this));
    this.subscribe("player-selected", () => document.body.classList.remove("roster-open"));
    this.subscribe("player-selected", () => this.loadSessions());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.clearTimeout(this.trailRefresh);
    this.worldMap.setReplayTime(null);
    this.worldMap.clearTrails();
    this.worldMap.classList.remove("interactable");
    document.body.classList.remove("roster-open");
    document.querySelector(".authed-section")?.classList.remove("no-pointer-events");
  }

  getSelectedPlane() {
    return parseInt(this.planeSelect.value, 10);
  }

  handlePlaneChange(evt) {
    const plane = evt.detail.plane;
    if (this.getSelectedPlane() !== plane) {
      this.planeSelect.value = plane;
    }
  }

  handlePlaneSelect() {
    this.worldMap.stopFollowingPlayer();
    this.worldMap.showPlane(this.getSelectedPlane());
  }

  handlePlaneWheel(event) {
    event.preventDefault();
    const current = this.getSelectedPlane();
    const direction = event.deltaY > 0 ? 1 : -1;
    const next = Math.min(Math.max(current + direction, 1), 4);
    if (next !== current) {
      this.planeSelect.value = next;
      this.handlePlaneSelect();
    }
  }

  handleFeatures(features) {
    const history = Boolean(features?.hub_history);
    this.eventControls.hidden = !history;
    const switchedOn = history && this.historyEnabled === false;
    this.historyEnabled = history;
    if (switchedOn) this.loadTrails();
    this.renderTrailChips();
  }

  // ---------------------------------------------------------------------------
  // Trails
  // ---------------------------------------------------------------------------

  handleTrailDaysChange() {
    const session = this.sessionChoices.find((choice) => choice.value === this.trailDaysSelect.value);
    if (session) {
      // Not remembered for the next visit: by then it is one session of many.
      this.pickedSession = { member: this.sessionsOf, ...session };
    } else {
      this.pickedSession = null;
      remember(TRAIL_DAYS_KEY, this.trailDaysSelect.value);
    }
    this.loadTrails();
  }

  /**
   * The time the trails are asked for: the session that was picked (`{from,
   * to}`, for every trail shown), else the number of days in the menu.
   */
  trailSpan() {
    if (this.pickedSession) return { from: this.pickedSession.from, to: this.pickedSession.to };
    return parseInt(this.trailDaysSelect.value, 10);
  }

  /** Back to the length the menu remembers: the session that was picked is no more. */
  dropSession() {
    this.pickedSession = null;
    this.trailDaysSelect.value = storedTrailDays(this.trailDaysSelect);
  }

  /**
   * Whose sessions the menu offers: whoever the session that was picked
   * belongs to, else the player the replay watches, picked as the map picks
   * them (CanvasMap.replayPlayer): the selected one when their trail is on
   * the map, else the first on it. A trail the hub doesn't share is not on
   * the map, so its player is not the one. Until the first trail is on the
   * map nobody is watched yet, and it goes by the trails that are asked for.
   */
  sessionOwner() {
    const asked = [...selection.trails];
    if (this.pickedSession && asked.includes(this.pickedSession.member)) return this.pickedSession.member;
    // A trail that was just switched off may still be on the map for a moment.
    const drawn = this.worldMap.trailNames().filter((name) => selection.hasTrail(name));
    const names = drawn.length ? drawn : asked;
    return names.includes(selection.selected) ? selection.selected : names[0] || null;
  }

  /**
   * Brings the sessions in the menu up to date, and with them the session
   * that was picked: it may have ended meanwhile, or be too long ago by now.
   * An answer that is still under way for another player than the one the
   * menu is for by then is dropped.
   */
  async loadSessions() {
    const owner = this.historyEnabled === false ? null : this.sessionOwner();
    this.sessionsWanted = owner;
    // Whatever is still under way was asked before this, maybe for another player.
    const requestId = (this.sessionsRequestId = (this.sessionsRequestId || 0) + 1);
    if (!owner) {
      this.showSessions(null, []);
      return;
    }
    if (owner === this.sessionsOf && Date.now() - this.sessionsAt < SESSIONS_REFRESH_MS) return;
    let sessions = [];
    try {
      sessions = (await api.getPlayerSessions(owner, SESSIONS_DAYS)).sessions;
    } catch (error) {
      // Not shared is an answer: no sessions to offer. Anything else (the hub
      // is busy) leaves the ones that are there until the next time.
      if (error.status !== 404 && owner === this.sessionsOf) return;
    }
    if (!this.isConnected || requestId !== this.sessionsRequestId) return;
    this.sessionsAt = Date.now();
    const picked = this.pickedSession;
    // The session that was picked stays in the list, however many came after it.
    const choices = sessionOptions(sessions, Date.now(), picked && picked.member === owner ? picked.start : null);
    const now = picked && picked.member === owner ? choices.find((choice) => choice.start === picked.start) : null;
    if (picked && picked.member === owner && !now) {
      this.showSessions(owner, choices);
      this.dropSession();
      this.loadTrails();
    } else if (now && now.to !== picked.to) {
      this.pickedSession = { member: owner, ...now };
      this.showSessions(owner, choices);
      this.loadTrails();
    } else {
      this.showSessions(owner, choices);
    }
  }

  /** Lists a player's sessions below the lengths in the menu, or none. */
  showSessions(owner, choices) {
    this.sessionsOf = owner;
    this.sessionChoices = choices;
    const select = this.trailDaysSelect;
    const days = this.pickedSession ? null : select.value;
    select.querySelector("optgroup")?.remove();
    if (choices.length) {
      const group = document.createElement("optgroup");
      group.label = `Sessions of ${owner}`;
      for (const choice of choices) group.appendChild(new Option(choice.label, choice.value));
      select.appendChild(group);
    }
    const picked = this.pickedSession && choices.some((choice) => choice.value === this.pickedSession.value);
    select.value = picked ? this.pickedSession.value : days || storedTrailDays(select);
    // A value that is no longer in the menu: the remembered length it is.
    if (!select.value) select.value = storedTrailDays(select);
  }

  handleReplayClick() {
    if (this.scrubber.isOpen) this.scrubber.close();
    else this.scrubber.open();
  }

  /** The replay shows a time on the trails, or was closed (null) and the map is live again. */
  handleReplayChange(event) {
    const { time, follow, hop } = event.detail;
    this.replayButton.setAttribute("aria-pressed", String(time !== null));
    this.replayButton.classList.toggle("active", time !== null);
    this.worldMap.setReplayTime(time, { follow: Boolean(follow), hop: hop || null });
  }

  /**
   * Fetches the selected trails and draws them, then again every minute. A
   * later call (another selection, another length) overtakes one whose
   * answer is still under way.
   */
  async loadTrails() {
    window.clearTimeout(this.trailRefresh);
    const requestId = (this.trailRequestId = (this.trailRequestId || 0) + 1);
    const names = [...selection.trails];
    // A session is its player's: with their trail taken off it is nobody's.
    if (this.pickedSession && !selection.hasTrail(this.pickedSession.member)) this.dropSession();
    this.loadSessions();
    // A trail that was switched off goes at once, whatever the request does.
    for (const name of this.worldMap.trailNames()) {
      if (!selection.hasTrail(name)) this.worldMap.clearTrail(name);
    }
    for (const name of [...this.trailData.keys()]) {
      if (!selection.hasTrail(name)) this.trailData.delete(name);
    }
    for (const name of [...this.trailEvents.keys()]) {
      if (!selection.hasTrail(name)) this.trailEvents.delete(name);
    }
    // Nothing to fetch, or (once the server has said so) no history to fetch it from.
    if (!names.length || this.historyEnabled === false) {
      this.trailError = null;
      this.trailFailures = 0;
      this.renderTrailChips();
      return;
    }
    this.renderTrailChips();

    const span = this.trailSpan();
    let retryIn = TRAIL_REFRESH_MS;
    try {
      const data = await api.getTrails(names, span);
      if (!this.isConnected || requestId !== this.trailRequestId) return;
      this.trailData = new Map(data.trails.map((trail) => [trail.member, trail]));
      this.trailDataOfSession = typeof span !== "number";
      const { windowS, until, from } = spanWindow(span, Math.floor(Date.now() / 1000));
      for (const trail of data.trails) {
        if (trail.shared) {
          const { color, light } = colorForName(trail.member);
          this.worldMap.setTrail(trail.member, trail, { color, light, windowS, until, from });
        } else {
          this.worldMap.clearTrail(trail.member);
        }
      }
      // Other trails may be on the map now, and the replay may watch another
      // player than the one whose sessions the menu has or is getting.
      if (this.sessionOwner() !== this.sessionsWanted) this.loadSessions();
      this.trailFailures = 0;
      this.trailError = staleNotice(data.as_of);
      this.showTrailEvents();
      this.loadTrailEvents();
    } catch (error) {
      if (!this.isConnected || requestId !== this.trailRequestId) return;
      // What is drawn stays; it is only getting older.
      this.trailError = error.status === 503 ? "Hub busy" : "Trails unavailable";
      this.trailFailures = (this.trailFailures || 0) + 1;
      retryIn = Math.min(TRAIL_RETRY_MS * 2 ** (this.trailFailures - 1), TRAIL_REFRESH_MS);
    }
    this.renderTrailChips();
    this.trailRefresh = window.setTimeout(() => this.loadTrails(), retryIn);
  }

  /**
   * Fetches the events of the players whose trails are shown, where that
   * hasn't been done lately, to mark them on the trails.
   */
  async loadTrailEvents() {
    const now = Date.now();
    const span = this.trailSpan();
    const key = spanKey(span);
    // The server leaves out the drops the map wouldn't show anyway.
    const minLoot = this.filters.minLoot || 0;
    const due = this.worldMap.trailNames().filter((name) => {
      const fetched = this.trailEvents.get(name);
      if (!fetched || now - fetched.at >= TRAIL_EVENTS_REFRESH_MS) return true;
      // Another time of trail, or smaller drops than were asked for.
      return fetched.span !== key || fetched.minLoot > minLoot;
    });
    if (!due.length) return;
    await Promise.all(
      due.map(async (name) => {
        // Noted before the answer, so a slow one isn't asked for twice.
        const known = this.trailEvents.get(name)?.events || [];
        const noted = { events: known, at: now, span: key, minLoot };
        this.trailEvents.set(name, noted);
        // The trails may show another time by the time the answer is in. It is
        // dropped then, and the player is still due: what is noted for them is
        // for the time before, unless the new time was asked for meanwhile. So
        // is an answer that was asked for again meanwhile, for smaller drops:
        // the answer to keep is the one to what was asked last.
        const wanted = () => this.trailEvents.get(name) === noted && spanKey(this.trailSpan()) === key;
        try {
          const events = await api.getTrailEvents(name, span, minLoot);
          if (wanted()) this.trailEvents.set(name, { events, at: now, span: key, minLoot });
        } catch (error) {
          // The trail is shown with what the live feed has. Not shared is an
          // answer; anything else (the hub is busy) is asked again with the
          // next refresh of the trails.
          if (error.status !== 404 && wanted()) {
            this.trailEvents.set(name, { events: known, at: 0, span: key, minLoot });
          }
        }
      }),
    );
    if (this.isConnected) this.showTrailEvents();
  }

  /** Marks on the trails shown what is known of their players' events: fetched, and from the live feed. */
  showTrailEvents() {
    const names = this.worldMap.trailNames();
    if (!names.length) return;
    const eventsByName = new Map();
    for (const name of names) {
      const events = new Map();
      for (const event of this.trailEvents.get(name)?.events || []) events.set(event.id, event);
      for (const event of this.liveEvents) {
        if (event.member === name) events.set(event.id, event);
      }
      eventsByName.set(name, [...events.values()]);
    }
    this.worldMap.setTrailEvents(eventsByName);
  }

  renderTrailChips() {
    const names = [...selection.trails];
    this.trailControls.hidden = !this.historyEnabled || names.length === 0;
    this.trailChips.replaceChildren(
      ...names.map((name) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "map-page__trail-chip";
        chip.dataset.name = name;
        chip.style.setProperty("--player-color", colorForName(name).color);
        const trail = this.trailData.get(name);
        const notShared = trail && !trail.shared;
        const empty = trail?.shared && trail.points.length === 0;
        // The server cuts a trail with more than it can send down to its newest part.
        const since = trail?.shared && trail.truncated && !empty ? trailStart(trail, this.trailDataOfSession) : null;
        const note = notShared ? " (not shared)" : empty ? " (no points)" : since ? ` (since ${since})` : "";
        chip.textContent = `${name}${note}`;
        chip.classList.toggle("map-page__trail-chip--off", Boolean(notShared || empty));
        chip.title = since ? "Too much to show for the whole period. Remove this trail" : "Remove this trail";
        return chip;
      }),
    );
    if (this.trailError) {
      const error = document.createElement("span");
      error.className = "map-page__trail-error";
      error.textContent = this.trailError;
      this.trailChips.appendChild(error);
    }
  }

  handleTrailChipClick(event) {
    const chip = event.target.closest(".map-page__trail-chip");
    if (chip) selection.toggleTrail(chip.dataset.name);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  renderEventControls() {
    const toggles = this.querySelector(".map-page__event-kinds");
    toggles.replaceChildren(
      ...EVENT_KINDS.map((kind) => {
        // The box is drawn before a label that follows its input.
        const toggle = document.createElement("span");
        toggle.className = "map-page__event-kind";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.id = `map-event-${kind.key}`;
        input.name = kind.key;
        input.checked = Boolean(this.filters[kind.key]);
        const label = document.createElement("label");
        label.htmlFor = input.id;
        label.textContent = kind.label;
        toggle.append(input, label);
        return toggle;
      }),
    );
    this.querySelector('.map-page__events input[name="toasts"]').checked = Boolean(this.filters.toasts);
    const minLoot = this.querySelector(".map-page__event-min-loot");
    minLoot.replaceChildren(...MIN_LOOT_OPTIONS.map(([value, text]) => new Option(text, String(value))));
    minLoot.value = String(this.filters.minLoot);
  }

  handleEventFilterChange(event) {
    const target = event.target;
    if (target.classList.contains("map-page__event-min-loot")) {
      this.filters.minLoot = parseInt(target.value, 10);
    } else if (target.name) {
      this.filters[target.name] = target.checked;
    }
    saveEventFilters(this.filters);
    this.worldMap.setEventFilters(this.filters);
    // Smaller drops than the trails' events were fetched with have to be asked for.
    this.loadTrailEvents();
  }

  handleLiveEvents(feed) {
    this.liveEvents = feed.events;
    const bringsNews = this.liveEventsBringNews(feed);
    const news = bringsNews ? feed.added : [];
    // All of them when the feed starts (over), and after that what is new on a trail that is shown.
    if (!bringsNews || news.some((event) => selection.hasTrail(event.member))) this.showTrailEvents();
    // The map puts the events on itself; this page announces them.
    const now = api.serverNow();
    for (const event of news) {
      // What turns up late (the tab was hidden, say) is no news any more.
      if (this.filters.toasts && eventPasses(event, this.filters) && eventIsFresh(event, now)) {
        this.toasts.show(event, { color: colorForName(event.member).light });
      }
    }
  }
}
customElements.define("map-page", MapPage);
