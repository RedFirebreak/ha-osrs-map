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
| `teleport` | A dashed arc with a burst at both ends; a stub at each end when the other end is on another part of the map |
| `gap` | A dotted link: nothing is known about what happened |
| none | The first point of an answer, a label this server doesn't know, or a hub from before D-103. The map then guesses from distance and time, as it does for the positions it sees live between two reads of the trail |

**Reading.** An answer holds the newest 20,000 points and says `truncated` when older ones were
left out, so the backend reads a trail in two parts (`server/src/hub/trails.rs`):

- The older part, up to 15 minutes ago: pages of 20,000 backwards, with `to` set to the first
  point's `at`, until `truncated` is false or ten pages were read (some 33 hours of running; what
  lies before is left out and the trail says "since ..."). Read once every 10 minutes per player and
  length, and kept thinned.
- The recent part, from the older part's last point on: one request, every minute. A late message
  can add points up to 15 minutes back, which is why the older part ends there.

So a trail costs one request a minute, plus 1 to 10 every ten minutes. A player who made their
trail private is a 404 on the next read, and their trail is gone within a minute.

**Labels and thinning.** A label belongs to two points as the hub returned them, so it is read
before anything is removed. Consecutive points on one tile become a stay, which keeps the label of
its first point. A trail of more than 3000 stays is thinned to the first one of every so many
seconds, keeping both points of every step that isn't a `move`, and of every boat and world change;
between two points that are kept, only moves were left out. Points without a label fall back to the
old rule (another part of the map, more than five minutes, or further than a run).

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
