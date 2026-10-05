# What the guild map uses from osrs-data-hub

The map reads everything through the hub's `/api/v1` with one key, server-side; browsers never see it.
The consumer code is in `server/src/hub/`, and `tools/mock-hub/server.js` imitates the endpoints below
for local development.

## Endpoints

| Hub endpoint | Map use | Cached |
|---|---|---|
| `GET /me` | Key kind, rate limit and bulk size at start-up; admin "Test connection" | – |
| `GET /members/{discord_id}` | Who may log in, and who is an admin: asked when someone logs in with Discord, and again every 15 min per person with a session (at most 50 a minute). `member: false` ends their sessions; no answer leaves them. Service keys only: with a personal key, or a hub from before D-100, it is a 404 and nobody can log in | – |
| `GET /snapshot?since=` (ETag) | Mirrored into the members table every 5 s, full refresh every 2 min | – |
| `GET /events?cursor=` | One follower every 5 s into a 1000-event buffer: the Clan feed, the events on the map and its toasts | – |
| `GET /xp?accounts=` (≤50) | Graphs | 5 min |
| `GET /leaderboards/gains` | Clan page, the graphs' default players | 5 min |
| `GET /leaderboards/loot` | Clan page "Biggest drops" (falls back to the event buffer on older hubs) | 1 min |
| `GET /locations?accounts=&from=&to=` | Trails of up to 8 players, one account per request. See "Trails" below | 1 min and 10 min |
| `GET /accounts/{id}/gains` | Profile → Gains | 2 min |
| `GET /accounts/{id}/sessions` | Profile → Activity (play time) | 1 min |
| `GET /accounts/{id}/wealth` | Profile → Wealth | 5 min |
| `GET /accounts/{id}/equipment-history` | Profile → Gear | 2 min |
| `GET /events?accounts=` | Profile → Activity (a player's recent events) | 30 s |
| `GET /events?accounts=&from=` | The events marked on a trail, over its length: pages of 500, newest first, until `next_cursor` is null or 2000 events. When the map leaves out small drops, drops (`types=loot,pk_loot&min_value=`, from the smallest drop the map shows) are read apart from the other kinds, so a trail costs 2 to 8 requests; with every drop shown it is one read of all kinds, 1 to 4 requests. The site asks once per trail and again every 10 min. A hub from before D-98 ignores `from` and hands back a feed cursor; the backend then keeps that one page | 2 min |

## Snapshot fields

`id`, `name`, `account_hash` (matching existing members),
`online`, `last_seen`, `world`, `special_world`, `hp`, `prayer`, `location`, `skills`, `inventory`,
`equipment`, plus the display details stored as `hub_meta`: `type`/`type_label`, `owner.name`,
`categories`, `skills.total_level`/`overall_xp`, `inventory.value`/`equipment.value`, `spellbook`,
`game_state` and `location.is_on_boat`.

Presence comes from `online` and `last_seen`. `game_state` is shown as a detail only: the hub doesn't
clear it when an account times out.

## Trails

The hub has a point for every game tick on which a player's tile changed, and one a minute while
they stand still (D-102). Each point says how the player got there from the point before it in the
hub's answer (`via`, D-103), so the map doesn't guess teleports:

| `via` | On the map |
|---|---|
| `move` | A line: a walk, stairs when the floor differs, a sail when both points are on a boat |
| `entrance` | A ring at both ends, no line |
| `house` | The next room of a player-owned house: no line and no arc, a small house where the player came in. The replay doesn't hold there and the timeline has no tick for it |
| `teleport` | A dashed arc with a burst at both ends; a stub at each end when the other end is on another part of the map. The replay stops for it and plays it out |
| `gap` | A dotted link: nothing is known about what happened |
| none | The first point of an answer, a label this server doesn't know, or a hub from before D-103. The map then guesses from distance and time, as it does for the positions it sees live between two reads of the trail |

**Reading.** An answer holds the newest 20,000 points and says `truncated` when older ones were
left out, so the backend reads a trail in two parts (`server/src/hub/trails.rs`):

- The older part, up to 15 minutes ago: pages of 20,000 backwards, with `to` set to the first
  point's `at`, until `truncated` is false or ten pages were read (some 33 hours of running; what
  lies before is left out and the trail says "since ..."). Read once every 10 minutes per player and
  length, and kept thinned, with what each stay that is left weighs (see below).
- The recent part, from the older part's last point on: one request, every minute. A late message
  can add points up to 15 minutes back, which is why the older part ends there.

So a trail costs one request a minute, plus 1 to 10 every ten minutes. A player who made their
trail private is a 404 on the next read, and their trail is gone within a minute.

**The newest end.** Between two reads the site adds to a trail where it has seen the player's
marker since. A marker is the hub's own position a few seconds late (the backend's sync, the site's
poll), so wherever the site saw it before the hub gave the trail is in the trail already. The
backend sends that time with every trail (`as_of`, by its own clock, which also dates what the site
sees), and the site adds only what it saw from then on. The times of the hub's points can't decide
this: they are the plugin's clock, and the newest of them can be a minute older than the message it
came in. For a few seconds after a read the trail can be ahead of the marker; it then ends where
the hub has the player, not on the marker.

**Labels and thinning.** A label belongs to two points as the hub returned them, so it is read
before anything is removed. Consecutive points on one tile become a stay, which keeps the label of
its first point. A trail of more than 3000 stays, or whose older part has more than 2700, is
thinned without moving its line. A stay is left out when the straight line between the stays kept
around it has the player within a tile of it at that time, at an even pace: the tiles of a
straight run go, a corner stays, and so does a tile the player stood on for a while. When that
isn't enough the smallest corners go too, up to 4 tiles off the line, and after that only the time
allowed between two points grows, from a minute up to six hours. Both points of every step that
isn't a `move`, and of every boat, world and floor change, are always kept; between two points
that are kept, only moves were left out. A trail that still has too many stays is cut short and
says so (`truncated`): the map shows the newest part with the way that was walked and
"since ...", not straight lines from one teleport to the next. Points without a label fall back
to the old rule (another part of the map, more than five minutes, or further than a run).

Every stay is weighed once, against the stays the hub gave. The older part is cached with the
weights of what is left of it; when the recent part is added only the new stays are weighed, and
both are cut at one level, never a finer one than the older part's. The older part is cut to 2700
points, so that the recent part seldom is what pushes the trail to a coarser level.

`step` is the longest time between two points of a thinned trail with no break between them, and
60 when nothing was thinned. On a busy trail it stays near a minute; where a player kept to one
small patch for hours it is those hours. The site takes it for how far apart two points of one
walk can be (`gapS`), and goes by the kind of step, not by the time, for what the replay skips.
The answer doesn't say how far off the line may be: up to 4 tiles whenever the trail was thinned.

What fits. A hub that has a point per game tick has 100 a minute for a player who runs, so the
trail of an active player is thinned, the one of 24 hours too. What can't go is a corner more than
4 tiles off and both ends of a break, so how far back 3000 points reach depends on the play:
running without a stop with a corner every few seconds, some four hours (a test pins that); play
with stops and straight stretches, a day or more (an estimate from made-up play, not measured on
real trails). One point a minute (a plugin from before 1.6) is thinned the same way: a point more
than 4 tiles off the line between its neighbours is a corner that stays, the rest loses time. A
week of straight legs fits (a test pins that); a week round the clock that turns every minute is
all corners and is cut short, where the old thinning showed the whole week at a coarser step.

**To the site.** A point is `[x, y, plane, unix seconds, dwell, flags, via]` with `via` 1 move, 2
entrance, 3 house, 4 teleport, 5 gap and 0 (left out) when the hub didn't say. The response has
`"v": 3`. Times are whole seconds.

## Categories

A player who hasn't changed the hub's defaults shares `stats`, `events`, `activity` and `location_live`
with the guild. `inventory`, `equipment` and `location_history` are private by default, so their profile
tabs and trails show "not shared". The map reads `categories` to tell "not shared" from "empty".

What the key may not read, the map doesn't hold. A field the hub leaves out because its category is
off the account's `categories` empties what the map stored for it, in the database and in
`GET /api/members` (an empty array), and the site drops it: no marker, no items, no vitals.

| Category        | What the map drops                 |
| --------------- | ---------------------------------- |
| `location_live` | the position                       |
| `activity`      | hitpoints, prayer and world        |
| `stats`         | the skills (the history is kept)   |
| `inventory`     | the inventory and its value        |
| `equipment`     | the equipment and its value        |

A field of a category the key can read that has nothing new (a location the hub calls `stale` after a
logout, a special world, something the plugin never sent) leaves what the map has: a player who logged
out stays where they were last seen.

## Hub changes made for the map

| Change | Hub decision | Where |
|---|---|---|
| Service keys owned by the guild | D-88, D-89 | osrs-data-hub PR #8 |
| `owner {name, discord_id}` | D-90 | PR #8 |
| `account_hash` for service keys | D-91 | PR #8 |
| Bulk `/xp` and `/locations` for 50 accounts | D-92 | PR #8 |
| `inventory_slot` on items | D-86 | earlier |
| `game_state` on `/snapshot` | D-94 | osrs-data-hub PRs #13 and #16 |
| `GET /leaderboards/loot` | D-94 | PRs #13 and #16 |
| `from`/`to` on `GET /events`: a time range, newest first | D-98 | osrs-data-hub PR #43 |
| `GET /members/{discord_id}`: whether a Discord account is a member and an admin | D-100 | osrs-data-hub PR #46 |
| A trail point per game tick, 20,000 to an answer, `truncated` | D-102 | osrs-data-hub PR #48 |
| `via` on every trail point: how the player got there | D-103 | osrs-data-hub PR #49 |

Push to keys (webhooks or a key-authenticated stream) was deferred (D-93); polling stays the contract.
