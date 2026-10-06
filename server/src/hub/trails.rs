//! Where players have been: the hub's location history as trails for the
//! map, with stays on one tile merged and long trails thinned.
//!
//! The hub has a point per game tick while a player moves (hub D-102), at
//! most 20,000 to an answer, so a trail is read in two parts: the older part,
//! in pages, once every ten minutes, and what came after it every minute.
use crate::auth_middleware::Authenticated;
use crate::config::Config;
use crate::hub::client::{HubError, Priority};
use crate::hub::fetch::{fetch_json, history_enabled, list_param, parse, HistoryError};
use crate::hub::models::{HubAccountLocations, HubLocationPoint, HubLocationsMulti, HubVia};
use crate::hub::HubContext;
use actix_web::{get, web, HttpResponse};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// How long the recent part of a trail is served from the cache.
const RECENT_TTL: Duration = Duration::from_secs(60);
/// How long the older part is: reading it can take several requests.
const OLDER_TTL: Duration = Duration::from_secs(600);
/// The older part ends this long ago. A late message can still add points up
/// to 15 minutes back (the hub's API.md), and those belong to the recent part.
const SETTLE_SECS: i64 = 15 * 60;
/// Pages of 20,000 points read for one trail, newest first; what lies before
/// them is left out and the trail says it was cut short. Ten pages are some
/// 33 hours of running without a stop.
const MAX_TRAIL_PAGES: usize = 10;
const MAX_TRAIL_POINTS: usize = 3000;
/// What the older part of a trail is cut to. The rest is for the recent part,
/// so that it seldom is what pushes the whole trail to a coarser level.
const OLDER_MAX_POINTS: usize = MAX_TRAIL_POINTS - 300;
/// Trails requested at once; more lines than this are unreadable anyway.
pub(crate) const MAX_TRAILS: usize = 8;
/// The longest trail there is, in days. What fits of a busy player's trail is
/// far less than a week of play, so further back there is nothing to show.
pub(crate) const MAX_TRAIL_DAYS: i64 = 7;

/// A player standing still keeps one point a minute, so the points of a trail
/// that wasn't thinned are never further apart than this without a gap.
const TRAIL_IDLE_SECS: i64 = 60;
/// Samples further apart than this are a gap in the data (logged out, or not sharing).
const TRAIL_GAP_SECS: i64 = 300;
/// Running covers two tiles per 0.6 s game tick.
const RUN_TILES_PER_SEC: f64 = 2.0 / 0.6;
/// What a trail with too many points may lose, tried in turn: how far (in
/// tiles) its line may pass from a tile that was left out, and how long (in
/// seconds) it may take from one point to the next. The way goes first, as
/// far as cutting a corner still stays on the path; after that only the time.
const THIN_LEVELS: [(f64, i64); 10] = [
    (1.0, 60),
    (2.0, 60),
    (3.0, 60),
    (4.0, 60),
    (4.0, 120),
    (4.0, 300),
    (4.0, 600),
    (4.0, 1800),
    (4.0, 3600),
    (4.0, 21600),
];
/// The weight of a point that is kept at every level.
const ALWAYS: usize = THIN_LEVELS.len();
/// A walk of more points than this is weighed in halves, each with its own
/// ends: weighing takes a look at every point of a part for each point it
/// keeps, which on hours without a break could run to minutes.
const MAX_WEIGHED_POINTS: usize = 2048;
/// The hub's times are read to the second and a game tick is 0.6 s, so when a
/// player was on a tile is known to within this.
const TIME_SLACK_SECS: i64 = 1;
const FLAG_BOAT: i64 = 1;

/// A stay on one tile, from the hub's `first` sample there to the `last` (unix seconds).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct TrailPoint {
    pub x: i32,
    pub y: i32,
    pub plane: i32,
    pub first: i64,
    pub last: i64,
    pub boat: bool,
    pub world: Option<i32>,
    /// How the hub says the player got here from the point before: the label
    /// of the stay's first sample. None when the hub didn't say.
    pub via: Option<HubVia>,
    /// Something other than walking on happened on the way here (see
    /// `is_break`). Thinning keeps this point and the one before it, so the
    /// flag and `via` stay right on a thinned trail.
    pub jump: bool,
}

/// A trail ready to send: `step` is the longest time between two points with
/// no break between them (a minute when nothing was thinned, else what
/// thinning left, see `Weighed::built`); `truncated` when the trail was too
/// long and its oldest points were dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BuiltTrail {
    pub points: Vec<TrailPoint>,
    pub step: i64,
    pub truncated: bool,
}

/// The parts of the map with their own coordinate range: moving between them is
/// never done on foot. Caves and dungeons mirror the surface 6400 tiles north.
#[derive(PartialEq, Eq, Clone, Copy)]
enum Band {
    Surface,
    Underground,
    Instance,
    Other,
}

fn band(x: i32, y: i32) -> Band {
    if x >= 6400 {
        Band::Instance
    } else if y < 4224 {
        Band::Surface
    } else if (8448..10624).contains(&y) {
        Band::Underground
    } else {
        Band::Other
    }
}

/// Adds the hub's samples to a trail's stays, merging consecutive samples on
/// the same tile into one stay. The labels are read here, while every sample
/// still follows the one the hub judged it against.
pub(crate) fn extend_stays(stays: &mut Vec<TrailPoint>, points: &[HubLocationPoint]) {
    for point in points {
        let at = point.at.timestamp();
        let boat = point.is_on_boat.unwrap_or(false);
        let walked = matches!(point.via, None | Some(HubVia::Move));
        match stays.last_mut() {
            Some(stay)
                if walked
                    && (stay.x, stay.y, stay.plane) == (point.x, point.y, point.plane)
                    && stay.boat == boat
                    && stay.world == point.world
                    && at - stay.last <= TRAIL_GAP_SECS =>
            {
                stay.last = at
            }
            _ => {
                let mut next = TrailPoint {
                    x: point.x,
                    y: point.y,
                    plane: point.plane,
                    first: at,
                    last: at,
                    boat,
                    world: point.world,
                    via: point.via,
                    jump: false,
                };
                next.jump = stays.last().is_some_and(|last| is_break(last, &next));
                stays.push(next);
            }
        }
    }
}

/// Whether something other than walking on happened between two points: any
/// step the hub doesn't call a move, boarding a boat or a world hop. For a
/// point the hub didn't label (a hub from before D-103, or the first point of
/// its answer) the old guess stands: another part of the map, a gap in the
/// data, or further than a run. That guess is deliberately more eager than
/// the site's own, so thinning never removes a point the site needs.
fn is_break(a: &TrailPoint, b: &TrailPoint) -> bool {
    if a.boat != b.boat || (a.world.is_some() && b.world.is_some() && a.world != b.world) {
        return true;
    }
    match b.via {
        Some(HubVia::Move) => false,
        Some(_) => true,
        None => {
            let elapsed = (b.first - a.last).max(1);
            let distance = (a.x - b.x).abs().max((a.y - b.y).abs()) as f64;
            band(a.x, a.y) != band(b.x, b.y)
                || elapsed > TRAIL_GAP_SECS
                || distance > 0.75 * RUN_TILES_PER_SEC * elapsed as f64
        }
    }
}

/// How far (in tiles) a trail is off for the stay `p` when it goes straight
/// from `a` to `b`: from `p` to where on that line the player would be while
/// they were on `p`, at an even pace. So a corner counts, and so does a tile
/// on the line that the player stood on for a while.
fn off_the_line(a: &TrailPoint, b: &TrailPoint, p: &TrailPoint) -> f64 {
    let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
    let (px, py) = ((p.x - a.x) as f64, (p.y - a.y) as f64);
    let length = dx * dx + dy * dy;
    let nearest = if length > 0.0 {
        (px * dx + py * dy) / length
    } else {
        0.0
    };
    let span = (b.first - a.last) as f64;
    let reached = |time: i64| ((time - a.last) as f64 / span).clamp(0.0, 1.0);
    let off_at = |time: i64| {
        let (from, to) = if span > 0.0 {
            (
                reached(time - TIME_SLACK_SECS),
                reached(time + TIME_SLACK_SECS),
            )
        } else {
            (0.0, 1.0)
        };
        let along = nearest.clamp(from, to);
        (px - dx * along).hypot(py - dy * along)
    };
    off_at(p.first).max(off_at(p.last))
}

/// Weighs the points between `from` and `to`, which are kept and have only
/// moves between them: `weights[i]` becomes the number of levels of
/// `THIN_LEVELS` at which point i is still needed. Without the points that
/// aren't needed at a level, the line passes within that level's tiles of each
/// of them (see `off_the_line`) and no two points left are further apart in
/// time than its seconds. Points that the finest level can do without keep
/// their weight of 0.
fn weigh_walk(points: &[TrailPoint], from: usize, to: usize, weights: &mut [usize]) {
    let mut parts = vec![(from, to, ALWAYS)];
    while let Some((a, b, limit)) = parts.pop() {
        if b - a < 2 {
            continue;
        }
        if b - a > MAX_WEIGHED_POINTS {
            let middle = a + (b - a) / 2;
            weights[middle] = limit;
            parts.push((a, middle, limit));
            parts.push((middle, b, limit));
            continue;
        }
        let (mut furthest, mut off) = (a + 1, 0.0);
        for i in a + 1..b {
            let distance = off_the_line(&points[a], &points[b], &points[i]);
            if distance > off {
                (furthest, off) = (i, distance);
            }
        }
        let long = points[b].first - points[a].last;
        let for_the_way = THIN_LEVELS.iter().filter(|level| off > level.0).count();
        let for_the_time = THIN_LEVELS.iter().filter(|level| long > level.1).count();
        // Never more than the point this part was split off at, so that what
        // is kept at one level is kept at every finer one.
        let weight = for_the_way.max(for_the_time).min(limit);
        if weight == 0 {
            continue;
        }
        let split = if for_the_way >= for_the_time {
            furthest
        } else {
            // Nothing is far off, it only took long: the point halfway in time.
            let halfway = points[a].last + long / 2;
            (a + 1 + points[a + 1..b].partition_point(|point| point.first < halfway)).min(b - 1)
        };
        weights[split] = weight;
        parts.push((a, split, weight));
        parts.push((split, b, weight));
    }
}

/// Weighs the points of a trail from `from` on (see `weigh_walk`): the first
/// point, or the last one of a part that was weighed before, which then stays
/// an end. The ends of the trail, both sides of every break and both sides of
/// every change of floor are needed at every level. The points between two of
/// those are weighed on their own, so what is kept of them doesn't change as
/// the window slides.
fn weigh(points: &[TrailPoint], from: usize, weights: &mut Vec<usize>) {
    weights.resize(points.len(), 0);
    let Some(last) = points.len().checked_sub(1) else {
        return;
    };
    weights[from] = ALWAYS;
    weights[last] = ALWAYS;
    let mut start = from;
    for to in from + 1..=last {
        if points[to].jump || points[to].plane != points[to - 1].plane {
            weights[to - 1] = ALWAYS;
            weights[to] = ALWAYS;
            weigh_walk(points, start, to - 1, weights);
            start = to;
        } else if to == last {
            weigh_walk(points, start, to, weights);
        }
    }
}

/// The stays of a trail that are kept, each with its weight (see `weigh`).
/// `level` is the level of `THIN_LEVELS` the others were left out at, None
/// when none were; `truncated` when even the last level left too many and the
/// oldest were dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Weighed {
    points: Vec<TrailPoint>,
    weights: Vec<usize>,
    level: Option<usize>,
    truncated: bool,
}

impl Weighed {
    /// The trail as it is sent. `step` is the longest time between two of its
    /// points with no break between them, when anything was left out: a stay
    /// is one point, and how long a break took says nothing about a walk.
    fn built(self) -> BuiltTrail {
        let step = match self.level {
            None => TRAIL_IDLE_SECS,
            Some(_) => self
                .points
                .windows(2)
                .filter(|pair| !pair[1].jump)
                .map(|pair| pair[1].first - pair[0].last)
                .fold(TRAIL_IDLE_SECS, i64::max),
        };
        BuiltTrail {
            points: self.points,
            step,
            truncated: self.truncated,
        }
    }
}

/// Cuts a weighed trail to at most `max_points` without moving its line: the
/// points left out are the ones the line passes closest to anyway (the tiles
/// of a straight run first, then the smallest corners). It takes the first
/// level from `at_least` on that leaves no more than fit; a trail that fits
/// as it is, with no level asked for, keeps every point.
fn cut(
    points: Vec<TrailPoint>,
    weights: Vec<usize>,
    at_least: Option<usize>,
    max_points: usize,
) -> Weighed {
    if at_least.is_none() && (points.len() <= max_points || max_points < 2) {
        return Weighed {
            points,
            weights,
            level: None,
            truncated: false,
        };
    }
    let kept_at = |level: usize| weights.iter().filter(|weight| **weight > level).count();
    // A trail that doesn't fit at the last level either is cut short: with
    // straight lines from break to break it would show more days and no way.
    let last = THIN_LEVELS.len() - 1;
    let level = (at_least.unwrap_or(0)..=last)
        .find(|level| kept_at(*level) <= max_points)
        .unwrap_or(last);
    let kept = kept_at(level);
    let mut drop = kept.saturating_sub(max_points);
    let (points, weights) = points
        .into_iter()
        .zip(weights)
        .filter(|(_, weight)| *weight > level)
        .skip_while(|_| {
            let dropping = drop > 0;
            drop = drop.saturating_sub(1);
            dropping
        })
        .unzip();
    Weighed {
        points,
        weights,
        level: Some(level),
        truncated: kept > max_points,
    }
}

/// A trail thinned in one go, as its older part is when it is read.
#[cfg(test)]
pub(crate) fn thin_trail(points: Vec<TrailPoint>, max_points: usize) -> BuiltTrail {
    let mut weights = Vec::new();
    weigh(&points, 0, &mut weights);
    cut(points, weights, None, max_points).built()
}

/// The label of a point as the site gets it; 0 when the hub didn't say, or
/// said something this server doesn't know.
fn via_code(via: Option<HubVia>) -> i64 {
    match via {
        None | Some(HubVia::Other) => 0,
        Some(HubVia::Move) => 1,
        Some(HubVia::Entrance) => 2,
        Some(HubVia::House) => 3,
        Some(HubVia::Teleport) => 4,
        Some(HubVia::Gap) => 5,
    }
}

/// A member's trail as the site gets it. A point is
/// `[x, y, plane, unix seconds, dwell, flags, via]`: the time is the last
/// sample on the tile, `dwell` the seconds since the first one, `flags` bit 0
/// is "on a boat", `via` how the player got there from the point before (see
/// `via_code`); trailing zeros are left out. `worlds` lists
/// `[point index, world]` wherever the world changes.
pub(crate) fn trail_json(member: &str, trail: &BuiltTrail) -> Value {
    let mut worlds: Vec<[i64; 2]> = Vec::new();
    let points: Vec<Vec<i64>> = trail
        .points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            if let Some(world) = point.world {
                if worlds.last().map(|last| last[1]) != Some(world as i64) {
                    worlds.push([index as i64, world as i64]);
                }
            }
            let mut entry = vec![
                point.x as i64,
                point.y as i64,
                point.plane as i64,
                point.last,
                point.last - point.first,
                if point.boat { FLAG_BOAT } else { 0 },
                via_code(point.via),
            ];
            while entry.len() > 4 && entry.last() == Some(&0) {
                entry.pop();
            }
            entry
        })
        .collect();
    serde_json::json!({
        "member": member,
        "shared": true,
        "step": trail.step,
        "truncated": trail.truncated,
        "points": points,
        "worlds": worlds,
    })
}

#[derive(Deserialize)]
pub(crate) struct TrailsQuery {
    #[serde(default)]
    members: Option<String>,
    #[serde(default)]
    days: Option<i64>,
}

/// The older part of a trail as it is kept in the cache: already thinned, so
/// that a week of ticks isn't held in memory, and with the weights of what is
/// left, so that nothing of it is weighed again when the recent part is added.
#[derive(Serialize, Deserialize)]
struct OlderTrail {
    /// The hub was asked for the points up to this time.
    until: DateTime<Utc>,
    /// The time of the last of them, where the recent part takes over.
    last_at: Option<DateTime<Utc>>,
    trail: Weighed,
}

/// The stays of a trail read in pages, the newest page first, as the hub
/// hands them out: a page starts with the point the page after it ends with.
fn join_pages(pages: &[Vec<HubLocationPoint>]) -> Vec<TrailPoint> {
    let mut stays = Vec::new();
    let mut last_at = None;
    for page in pages.iter().rev() {
        let known = page.partition_point(|point| Some(point.at) <= last_at);
        extend_stays(&mut stays, &page[known..]);
        last_at = page.last().map(|point| point.at).or(last_at);
    }
    stays
}

/// The older part of a trail from its pages (see `join_pages`), read up to
/// `until`. `cut_short` when the hub had more than was read.
fn older_part(
    pages: &[Vec<HubLocationPoint>],
    until: DateTime<Utc>,
    cut_short: bool,
) -> OlderTrail {
    let last_at = pages
        .first()
        .and_then(|page| page.last())
        .map(|point| point.at);
    let points = join_pages(pages);
    let mut weights = Vec::new();
    weigh(&points, 0, &mut weights);
    let mut trail = cut(points, weights, None, OLDER_MAX_POINTS);
    trail.truncated |= cut_short;
    OlderTrail {
        until,
        last_at,
        trail,
    }
}

/// The older part followed by what the hub has had since. `recent` was asked
/// for from the older part's last point on, so it starts with that point (or
/// with more that the older part already has, when it comes from the cache).
///
/// Only what is new is weighed. The older part has its weights from when
/// every one of its stays was still there; weighing what is left of it again
/// would count as near the line what is only near a line that was itself
/// drawn within the tolerance. Its last point stays an end for that reason,
/// and the two parts are cut at one level, never a finer one than the older
/// part's, so the trail doesn't change its level with every minute.
fn join_recent(older: OlderTrail, recent: &[HubLocationPoint]) -> Weighed {
    let from = older.last_at.unwrap_or(older.until);
    let known = recent.partition_point(|point| point.at <= from);
    let Weighed {
        mut points,
        mut weights,
        level,
        truncated,
    } = older.trail;
    let end = points.len().saturating_sub(1);
    extend_stays(&mut points, &recent[known..]);
    weigh(&points, end, &mut weights);
    let mut joined = cut(points, weights, level, MAX_TRAIL_POINTS);
    joined.truncated |= truncated;
    joined
}

fn hub_time(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn only_account(answer: HubLocationsMulti) -> Result<HubAccountLocations, HubError> {
    answer.accounts.into_iter().next().ok_or(HubError::NotFound)
}

/// Reads the older part of an account's trail from the hub: page by page
/// backwards, with `to` set to the first point of the page before, until the
/// hub says nothing was left out.
async fn fetch_older(context: &HubContext, id: &str, days: i64) -> Result<Value, HubError> {
    let now = Utc::now();
    let until = now - ChronoDuration::seconds(SETTLE_SECS);
    let from = hub_time(now - ChronoDuration::days(days));
    let mut pages = Vec::new();
    let mut truncated = false;
    let mut to = until;
    for _ in 0..MAX_TRAIL_PAGES {
        let query = [
            ("accounts", id.to_owned()),
            ("from", from.clone()),
            ("to", hub_time(to)),
        ];
        let (answer, _) = context
            .client
            .get_data::<HubLocationsMulti>("/locations", &query, Priority::Interactive)
            .await?;
        let page = only_account(answer)?;
        truncated = page.truncated;
        let first = page.points.first().map(|point| point.at);
        pages.push(page.points);
        match first {
            Some(first) if truncated && first < to => to = first,
            _ => break,
        }
    }
    // Weighing a long trail takes a while: not on a thread that serves requests.
    tokio::task::spawn_blocking(move || {
        serde_json::to_value(older_part(&pages, until, truncated))
            .map_err(|err| HubError::Other(err.to_string()))
    })
    .await
    .map_err(|err| HubError::Other(format!("thinning a trail failed: {err}")))?
}

/// An account's trail over the last `days`, and how long ago its recent part
/// came from the hub. None when the key can't read the account's trail.
async fn account_trail(
    context: &HubContext,
    id: &str,
    days: i64,
) -> Result<Option<(BuiltTrail, Duration)>, HubError> {
    let older = context
        .cache
        .get_or_fetch(&format!("trail-older:{}:{}", days, id), OLDER_TTL, || {
            fetch_older(context, id, days)
        })
        .await;
    let older: OlderTrail = match older {
        Ok(value) => parse(&value)?,
        Err(HubError::NotFound) => return Ok(None),
        Err(err) => return Err(err),
    };
    // Asked for every minute, so a trail made private is gone within one.
    let from = hub_time(older.last_at.unwrap_or(older.until));
    let query = [("accounts", id.to_owned()), ("from", from)];
    let recent = context
        .cache
        .get_or_fetch_dated(&format!("trail-recent:{}:{}", days, id), RECENT_TTL, || {
            fetch_json(&context.client, "/locations", &query)
        })
        .await;
    let (recent, age) = match recent {
        Ok(found) => found,
        Err(HubError::NotFound) => return Ok(None),
        Err(err) => return Err(err),
    };
    let recent = only_account(parse(&recent)?)?;
    Ok(Some((join_recent(older, &recent.points).built(), age)))
}

#[get("/hub/trails")]
pub async fn get_trails(
    _auth: Authenticated,
    query: web::Query<TrailsQuery>,
    config: web::Data<Config>,
    context: web::Data<HubContext>,
) -> Result<HttpResponse, HistoryError> {
    history_enabled(&config)?;
    let days = query.days.unwrap_or(1).clamp(1, MAX_TRAIL_DAYS);
    let members = list_param(query.members.as_deref());
    if members.is_empty() || members.len() > MAX_TRAILS {
        return Err(HistoryError::BadRequest(format!(
            "give 1 to {} members",
            MAX_TRAILS
        )));
    }
    let context: &HubContext = &context;
    let answers = join_all(members.iter().map(|member| async move {
        match context.directory.hub_id(member) {
            Some(id) => account_trail(context, &id, days).await,
            None => Ok(None),
        }
    }))
    .await;
    let mut oldest = Duration::ZERO;
    let mut trails = Vec::with_capacity(members.len());
    for (member, answer) in members.iter().zip(answers) {
        trails.push(match answer? {
            Some((trail, age)) => {
                oldest = oldest.max(age);
                trail_json(member, &trail)
            }
            None => serde_json::json!({ "member": member, "shared": false }),
        });
    }
    // `as_of` is when the hub last answered: older than a minute means the
    // hub is unreachable and this is the cache's stale copy.
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "v": 3,
        "days": days,
        "as_of": Utc::now().timestamp() - oldest.as_secs() as i64,
        "trails": trails,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;
    use std::collections::HashSet;

    const TRAIL_START: i64 = 1_790_000_040;

    /// The stays of a trail the hub gave in one answer.
    fn merge_stays(points: &[HubLocationPoint]) -> Vec<TrailPoint> {
        let mut stays = Vec::new();
        extend_stays(&mut stays, points);
        stays
    }

    fn sample(minute: i64, x: i32, y: i32) -> HubLocationPoint {
        HubLocationPoint {
            at: DateTime::from_timestamp(TRAIL_START + minute * 60, 0).unwrap(),
            x,
            y,
            plane: 0,
            world: Some(302),
            is_on_boat: Some(false),
            via: None,
        }
    }

    /// A sample `seconds` into the trail that the hub labelled.
    fn tick(seconds: i64, x: i32, y: i32, via: HubVia) -> HubLocationPoint {
        HubLocationPoint {
            at: DateTime::from_timestamp(TRAIL_START + seconds, 0).unwrap(),
            via: Some(via),
            ..sample(0, x, y)
        }
    }

    /// A walk of a few tiles a minute that never looks like a break.
    fn walk(minutes: std::ops::Range<i64>) -> Vec<HubLocationPoint> {
        minutes
            .map(|i| sample(i, 3000 + (i % 100) as i32, 3200 + (i / 100) as i32))
            .collect()
    }

    /// A route as the hub has it for a player on the move: a point for every
    /// game tick (0.6 s, which the map reads to the second) on which the tile
    /// changed.
    struct Route {
        points: Vec<HubLocationPoint>,
        ticks: i64,
        x: i32,
        y: i32,
    }

    impl Route {
        fn from(x: i32, y: i32) -> Self {
            let mut route = Route {
                points: Vec::new(),
                ticks: 0,
                x,
                y,
            };
            route.arrive(HubVia::Move);
            route
        }

        fn arrive(&mut self, via: HubVia) {
            self.points
                .push(tick(self.ticks * 6 / 10, self.x, self.y, via));
        }

        fn teleport(&mut self, x: i32, y: i32) {
            self.ticks += 1;
            (self.x, self.y) = (x, y);
            self.arrive(HubVia::Teleport);
        }

        /// Runs `tiles` tiles in a straight line, two a tick.
        fn run(&mut self, dx: i32, dy: i32, tiles: i32) {
            for _ in 0..tiles / 2 {
                self.ticks += 1;
                self.x += 2 * dx;
                self.y += 2 * dy;
                self.arrive(HubVia::Move);
            }
        }

        /// One tick's move of at most two tiles each way.
        fn step(&mut self, dx: i32, dy: i32) {
            self.ticks += 1;
            self.x += dx;
            self.y += dy;
            self.arrive(HubVia::Move);
        }

        /// Stands still, for less than the minute after which the hub adds a point.
        fn stand(&mut self, ticks: i64) {
            self.ticks += ticks;
        }

        /// Stands still for minutes: the hub has a point for each of them.
        fn wait(&mut self, minutes: i64) {
            for _ in 0..minutes {
                self.ticks += 100;
                self.arrive(HubVia::Move);
            }
        }

        /// Is gone for a while (logged out), and back on the same tile.
        fn away(&mut self, minutes: i64) {
            self.ticks += minutes * 100;
            self.arrive(HubVia::Gap);
        }
    }

    /// The same points again: a page of the hub's answer is handed over whole.
    fn copy(points: &[HubLocationPoint]) -> Vec<HubLocationPoint> {
        points
            .iter()
            .map(|point| HubLocationPoint {
                at: point.at,
                x: point.x,
                y: point.y,
                plane: point.plane,
                world: point.world,
                is_on_boat: point.is_on_boat,
                via: point.via,
            })
            .collect()
    }

    /// The next of a fixed series of numbers that look random.
    fn next(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    /// Trips to a guild's bank: a teleport to its gate, 60 tiles west and 30
    /// south to the bank, a moment there, and a teleport away to a few minutes
    /// of running about.
    fn bank_trips(trips: i32) -> Vec<HubLocationPoint> {
        let mut route = Route::from(3200, 3200);
        for trip in 0..trips {
            bank_trip(&mut route, trip);
        }
        route.points
    }

    fn bank_trip(route: &mut Route, trip: i32) {
        route.teleport(1658 + trip % 5, 3505);
        route.run(-1, 0, 60);
        route.run(0, -1, 30);
        route.stand(20);
        route.teleport(3200, 3200);
        for _ in 0..12 {
            route.run(1, 0, 20);
            route.run(0, 1, 10);
            route.run(-1, 0, 20);
            route.run(0, 1, 10);
        }
    }

    /// How far (in tiles) the line of a thinned trail passes from the tiles the
    /// player was on: the furthest that one of `stays` lies from the line
    /// between the two points of `built` it was left out between. What came
    /// before a trail that was cut short isn't looked at.
    fn furthest_off_the_line(stays: &[TrailPoint], built: &BuiltTrail) -> f64 {
        let mut kept = 0;
        let mut furthest: f64 = 0.0;
        for stay in stays {
            if built.points.get(kept) == Some(stay) {
                kept += 1;
                continue;
            }
            if kept == 0 {
                continue;
            }
            let (a, b) = (&built.points[kept - 1], &built.points[kept]);
            let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
            let (px, py) = ((stay.x - a.x) as f64, (stay.y - a.y) as f64);
            let length = dx * dx + dy * dy;
            let along = if length > 0.0 {
                ((px * dx + py * dy) / length).clamp(0.0, 1.0)
            } else {
                0.0
            };
            furthest = furthest.max((px - dx * along).hypot(py - dy * along));
        }
        assert_eq!(
            kept,
            built.points.len(),
            "a thinned trail holds points of the trail only"
        );
        furthest
    }

    #[test]
    fn a_thinned_trail_keeps_to_the_tiles_that_were_walked() {
        // Close to three hours with a point every tick: five times what fits.
        let stays = merge_stays(&bank_trips(40));
        assert!(stays.len() > 15_000);
        let built = thin_trail(stays.clone(), 3000);
        assert!(built.points.len() <= 3000 && !built.truncated);
        // The way from the gate to the bank still goes round the corner.
        assert!(
            furthest_off_the_line(&stays, &built) <= 1.0,
            "the line passes {} tiles from where the player was",
            furthest_off_the_line(&stays, &built)
        );
    }

    #[test]
    fn a_longer_trail_loses_its_smallest_corners_first() {
        // Runs that sidestep two tiles every twenty: four corners each time.
        let mut route = Route::from(3200, 3200);
        for trip in 0..100 {
            route.teleport(1700, 3505 + trip % 7);
            for _ in 0..10 {
                route.run(-1, 0, 20);
                route.run(-1, 1, 2);
                route.run(-1, 0, 20);
                route.run(-1, -1, 2);
            }
        }
        let stays = merge_stays(&route.points);
        let built = thin_trail(stays.clone(), 3000);
        assert!(built.points.len() <= 3000 && !built.truncated);
        // The sidesteps are gone and nothing else: the line is two tiles off
        // at most, and still has a point a minute.
        let off = furthest_off_the_line(&stays, &built);
        assert!(off > 1.0 && off <= 2.0, "{} tiles off", off);
        assert_eq!(built.step, 60);
    }

    #[test]
    fn hours_of_walking_without_a_break_are_thinned_like_any_walk() {
        // Round a block of 40 by 20 tiles, some three hours long.
        let mut route = Route::from(3200, 3200);
        for _ in 0..300 {
            route.run(1, 0, 40);
            route.run(0, 1, 20);
            route.run(-1, 0, 40);
            route.run(0, -1, 20);
        }
        let stays = merge_stays(&route.points);
        assert!(stays.len() > 8 * MAX_WEIGHED_POINTS);
        let built = thin_trail(stays.clone(), 3000);
        // Four corners a lap, a point a minute, and where it was halved.
        assert!(built.points.len() < 1500 && !built.truncated);
        assert_eq!(built.step, 60);
        assert!(furthest_off_the_line(&stays, &built) <= 1.0);
    }

    #[test]
    fn a_trail_too_long_to_keep_its_way_is_cut_short_rather_than_straightened() {
        // 21 hours of trips to the bank: forty times what fits.
        let stays = merge_stays(&bank_trips(300));
        let built = thin_trail(stays.clone(), 3000);
        assert_eq!(built.points.len(), 3000);
        assert!(built.truncated);
        assert_eq!(built.points.last(), stays.last());
        // What is left still goes round the corner on the way to the bank,
        // which is 26 tiles from the straight line there.
        let off = furthest_off_the_line(&stays, &built);
        assert!(off <= 4.0, "{} tiles off", off);
        // No two of its points are further apart than those of a trail that
        // wasn't thinned.
        assert_eq!(built.step, 60);
        // Running without a stop and a corner every few seconds is the least
        // that fits: some four of the 21 hours.
        let hours = (built.points[2999].last - built.points[0].first) as f64 / 3600.0;
        assert!((3.5..5.0).contains(&hours), "{} hours", hours);
    }

    #[test]
    fn a_corner_is_needed_for_as_long_as_the_line_would_miss_it_and_always_past_four_tiles() {
        // Twenty tiles on, `aside` tiles to the side, twenty tiles on, at an
        // even pace: the weight of the point in the middle.
        let weight_of_a_corner = |aside: i32| {
            let stays = merge_stays(&[
                tick(0, 3200, 3200, HubVia::Move),
                tick(10, 3220, 3200 + aside, HubVia::Move),
                tick(20, 3240, 3200, HubVia::Move),
            ]);
            let mut weights = Vec::new();
            weigh(&stays, 0, &mut weights);
            weights[1]
        };
        // On the line: never needed. Then a level for every tile up to four.
        assert_eq!(weight_of_a_corner(1), 0);
        assert_eq!(weight_of_a_corner(2), 1);
        assert_eq!(weight_of_a_corner(3), 2);
        assert_eq!(weight_of_a_corner(4), 3);
        // More than four tiles off is a corner the trail never loses.
        assert_eq!(weight_of_a_corner(5), ALWAYS);
    }

    #[test]
    fn a_thinned_trail_says_the_longest_time_it_left_between_two_points() {
        // A point a minute: thinning this is leaving time out.
        let built = thin_trail(merge_stays(&walk(0..5000)), 3000);
        let longest = built
            .points
            .windows(2)
            .map(|pair| pair[1].first - pair[0].last)
            .max()
            .unwrap();
        assert!(longest > 60);
        assert_eq!(built.step, longest);
    }

    #[test]
    fn a_break_and_a_stay_are_no_time_between_two_points() {
        // Trips with ten minutes on one tile in the middle of them, a few
        // tiles on, and three hours logged out.
        let mut route = Route::from(3200, 3200);
        for trip in 0..40 {
            bank_trip(&mut route, trip);
            if trip == 20 {
                route.wait(10);
                route.run(1, 0, 10);
                route.away(180);
            }
        }
        let stays = merge_stays(&route.points);
        let built = thin_trail(stays.clone(), 3000);
        assert!(built.points.len() < stays.len() && !built.truncated);
        // The ten minutes are one point, and the three hours are a break.
        let waited = built
            .points
            .iter()
            .find(|point| point.last - point.first == 600)
            .expect("the stay is kept");
        assert!(built
            .points
            .iter()
            .any(|point| point.via == Some(HubVia::Gap)));
        assert_eq!(waited.x, 3200);
        assert_eq!(built.step, 60);
    }

    #[test]
    fn a_trail_that_was_not_thinned_keeps_a_step_of_a_minute() {
        // Four minutes without a point is not a gap yet, and not thinning.
        let stays = merge_stays(&[sample(0, 3200, 3200), sample(4, 3210, 3200)]);
        let built = thin_trail(stays, 1000);
        assert_eq!((built.points.len(), built.step), (2, 60));
    }

    /// A walk that never goes straight for long: runs of 6 to 20 tiles with a
    /// sidestep of up to four between them, there and back along a road.
    fn winding_walk(route: &mut Route, legs: i32, seed: &mut u64) {
        for leg in 0..legs {
            let along = if (leg / 40) % 2 == 0 { -1 } else { 1 };
            route.run(along, 0, 6 + 2 * (next(seed) % 8) as i32);
            let aside = if next(seed) % 2 == 0 { 1 } else { -1 };
            for _ in 0..1 + next(seed) % 4 {
                route.step(0, aside);
            }
        }
    }

    /// Trips with a sidestep of four tiles every twenty, which only the
    /// coarsest tolerance can do without.
    fn sidestepping_trips(route: &mut Route, trips: i32) {
        for trip in 0..trips {
            route.teleport(1700, 3505 + trip % 7);
            for _ in 0..10 {
                route.run(-1, 0, 20);
                route.run(-1, 1, 4);
                route.run(-1, 0, 20);
                route.run(-1, -1, 4);
            }
        }
    }

    /// Hours of such trips, a long winding walk, and more trips: too much for
    /// anything but the coarsest tolerance, before the walk and after it. With
    /// the points: where the walk starts and where it ends.
    fn trips_around_a_long_walk() -> (Vec<HubLocationPoint>, usize, usize) {
        let mut route = Route::from(3200, 3200);
        sidestepping_trips(&mut route, 300);
        route.teleport(3200, 3400);
        let start = route.points.len();
        winding_walk(&mut route, 500, &mut 17);
        let end = route.points.len();
        sidestepping_trips(&mut route, 150);
        (route.points, start, end)
    }

    #[test]
    fn the_older_and_the_recent_part_are_thinned_as_one_trail() {
        let (points, start, end) = trips_around_a_long_walk();
        let stays = merge_stays(&points);
        // The older part ends in the middle of the walk.
        let split = start + (end - start) * 5 / 8;
        let until = points[split - 1].at;
        let older = older_part(&[copy(&points[..split])], until, false);
        assert_eq!(older.trail.level, Some(3));
        let joined = join_recent(older, &points[split - 1..]);
        assert_eq!((joined.level, joined.truncated), (Some(3), false));
        // Measured against every tile of the walk, not against what the older
        // part had left of it.
        let off = furthest_off_the_line(&stays, &joined.built());
        assert!(off <= 4.0, "{} tiles off", off);
    }

    #[test]
    fn a_trail_keeps_its_level_while_its_recent_part_grows() {
        let (points, start, end) = trips_around_a_long_walk();
        let split = start + 200;
        let until = points[split - 1].at;
        let older = older_part(&[copy(&points[..split])], until, false);
        assert_eq!(older.trail.level, Some(3));
        // The same older part for ten minutes, and more of the walk each one.
        for minutes in 1..=25 {
            let older = OlderTrail {
                until,
                last_at: older.last_at,
                trail: older.trail.clone(),
            };
            let recent = &points[split - 1..(split + minutes * 100).min(end)];
            let joined = join_recent(older, recent);
            assert_eq!(
                (joined.level, joined.truncated),
                (Some(3), false),
                "{} minutes on",
                minutes
            );
        }
    }

    #[test]
    fn the_older_part_leaves_room_for_the_recent_one() {
        // Trips of which the coarsest tolerance keeps just under 3000 points,
        // and the start of a long walk.
        let mut route = Route::from(3200, 3200);
        sidestepping_trips(&mut route, 586);
        route.teleport(3200, 3400);
        let start = route.points.len();
        winding_walk(&mut route, 500, &mut 17);
        let points = route.points;
        let split = start + 200;
        let stays = merge_stays(&points[..split]);
        let mut weights = Vec::new();
        weigh(&stays, 0, &mut weights);
        let fit_at_3 = weights.iter().filter(|weight| **weight > 3).count();
        assert!((2900..=3000).contains(&fit_at_3), "{} points", fit_at_3);
        // It would fit as it is, and the walk's next minutes would not. So the
        // older part goes a level further at once, and stays there.
        let until = points[split - 1].at;
        let older = older_part(&[copy(&points[..split])], until, false);
        assert_eq!(older.trail.level, Some(4));
        for minutes in 1..=25 {
            let older = OlderTrail {
                until,
                last_at: older.last_at,
                trail: older.trail.clone(),
            };
            let recent = &points[split - 1..(split + minutes * 100).min(points.len())];
            let joined = join_recent(older, recent);
            assert_eq!(
                (joined.level, joined.truncated),
                (Some(4), false),
                "{} minutes on",
                minutes
            );
        }
    }

    #[test]
    fn a_point_a_minute_on_straight_legs_is_thinned_by_time_and_a_week_of_it_fits() {
        // A hub or a plugin from before the tick trail: a week round the
        // clock, in straight legs of 5 to 15 minutes at a walk. Only the
        // turns are off the line, so what has to go is time. (A point a
        // minute that turns every minute is all corners, and is cut short.)
        let mut seed = 3;
        let (mut x, mut y) = (3000, 3400);
        let mut points = Vec::new();
        let mut minute = 0;
        while minute < 7 * 24 * 60 {
            let (dx, dy) = match (x, y) {
                (3500.., _) => (-1, 0),
                (..=2500, _) => (1, 0),
                (_, 3600..) => (0, -1),
                (_, ..=2900) => (0, 1),
                _ => [(1, 0), (0, 1), (-1, 0), (0, -1)][(next(&mut seed) % 4) as usize],
            };
            for _ in 0..5 + next(&mut seed) % 11 {
                points.push(sample(minute, x, y));
                x += 30 * dx;
                y += 30 * dy;
                minute += 1;
            }
        }
        let stays = merge_stays(&points);
        assert!(stays.iter().all(|stay| !stay.jump));
        let built = thin_trail(stays.clone(), 3000);
        assert!(built.points.len() <= 3000 && !built.truncated);
        // Five minutes between two points is what it took, and no more.
        assert_eq!(built.step, 300);
        assert_eq!(built.points[0].first, TRAIL_START);
        let off = furthest_off_the_line(&stays, &built);
        assert!(off <= 4.0, "{} tiles off", off);
    }

    #[test]
    fn location_points_parse_with_and_without_the_newer_fields() {
        let points: Vec<HubLocationPoint> = serde_json::from_value(serde_json::json!([
            {"at": "2026-09-29T00:00:00Z", "x": 1, "y": 2, "plane": 0},
            {"at": "2026-09-29T00:01:00Z", "x": 1, "y": 3, "plane": 0, "world": 330, "is_on_boat": true}
        ]))
        .unwrap();
        assert_eq!((points[0].world, points[0].is_on_boat), (None, None));
        assert_eq!(
            (points[1].world, points[1].is_on_boat),
            (Some(330), Some(true))
        );
        assert_eq!((points[0].via, points[1].via), (None, None));
    }

    #[test]
    fn location_points_say_how_the_player_got_there() {
        let answer: HubAccountLocations = serde_json::from_value(serde_json::json!({
            "account": {"id": "a", "name": "Alpha"},
            "truncated": true,
            "points": [
                {"at": "2026-09-29T00:00:00.000Z", "x": 1, "y": 2, "plane": 0, "via": null},
                {"at": "2026-09-29T00:00:00.600Z", "x": 1, "y": 3, "plane": 0, "via": "move"},
                {"at": "2026-09-29T00:00:01.200Z", "x": 1, "y": 6403, "plane": 0, "via": "entrance"},
                {"at": "2026-09-29T00:00:01.800Z", "x": 1900, "y": 7050, "plane": 0, "via": "teleport"},
                {"at": "2026-09-29T00:00:02.400Z", "x": 1960, "y": 7050, "plane": 0, "via": "house"},
                {"at": "2026-09-29T00:09:00.000Z", "x": 1960, "y": 7050, "plane": 0, "via": "gap"},
                {"at": "2026-09-29T00:09:00.600Z", "x": 1960, "y": 7051, "plane": 0, "via": "flight"}
            ]
        }))
        .unwrap();
        assert!(answer.truncated);
        let said: Vec<Option<HubVia>> = answer.points.iter().map(|point| point.via).collect();
        assert_eq!(
            said,
            [
                None,
                Some(HubVia::Move),
                Some(HubVia::Entrance),
                Some(HubVia::Teleport),
                Some(HubVia::House),
                Some(HubVia::Gap),
                Some(HubVia::Other),
            ]
        );
        // A hub from before the trail came in pages.
        let older: HubAccountLocations =
            serde_json::from_value(serde_json::json!({"account": {}, "points": []})).unwrap();
        assert!(!older.truncated);
    }

    #[test]
    fn a_stay_keeps_the_label_of_its_first_sample() {
        let points = vec![
            tick(0, 3200, 3200, HubVia::Move),
            tick(1, 2900, 3300, HubVia::Teleport),
            tick(61, 2900, 3300, HubVia::Move),
            tick(121, 2900, 3300, HubVia::Move),
            tick(122, 2901, 3300, HubVia::Move),
        ];
        let stays = merge_stays(&points);
        assert_eq!(stays.len(), 3);
        assert_eq!(stays[1].via, Some(HubVia::Teleport));
        assert_eq!(
            (stays[1].first, stays[1].last),
            (TRAIL_START + 1, TRAIL_START + 121)
        );
        let jumps: Vec<bool> = stays.iter().map(|stay| stay.jump).collect();
        assert_eq!(jumps, [false, true, false]);
    }

    #[test]
    fn a_stay_ends_where_the_hub_says_something_else_than_a_move() {
        // Back on the same tile after a gap, and after a teleport to where they stood.
        let points = vec![
            tick(0, 3200, 3200, HubVia::Move),
            tick(200, 3200, 3200, HubVia::Gap),
            tick(201, 3200, 3200, HubVia::Teleport),
        ];
        let stays = merge_stays(&points);
        assert_eq!(stays.len(), 3);
        assert!(stays[1].jump && stays[2].jump);
    }

    #[test]
    fn the_hub_decides_what_was_walked() {
        let step = |via, x| {
            merge_stays(&[tick(0, 3200, 3200, HubVia::Move), tick(60, x, 3200, via)])[1].jump
        };
        // A minute's run is a move when the hub says so, however far.
        assert!(!step(HubVia::Move, 3400));
        // And a few tiles are not, when it says they weren't walked.
        for via in [
            HubVia::Entrance,
            HubVia::House,
            HubVia::Teleport,
            HubVia::Gap,
            HubVia::Other,
        ] {
            assert!(step(via, 3203), "{:?}", via);
        }
        // Without a label the distance decides, as before.
        let unlabelled = |x| merge_stays(&[sample(0, 3200, 3200), sample(1, x, 3200)])[1].jump;
        assert!(unlabelled(3400));
        assert!(!unlabelled(3203));
        // A boat or another world is a break whatever the hub calls the step.
        let mut points = vec![
            tick(0, 3200, 3200, HubVia::Move),
            tick(1, 3201, 3200, HubVia::Move),
        ];
        points[1].is_on_boat = Some(true);
        assert!(merge_stays(&points)[1].jump);
        points[1].is_on_boat = Some(false);
        points[1].world = Some(330);
        assert!(merge_stays(&points)[1].jump);
    }

    #[test]
    fn stays_on_a_tile_are_merged_with_their_dwell() {
        let points = vec![
            sample(0, 3200, 3200),
            sample(1, 3200, 3200),
            sample(2, 3200, 3200),
            sample(3, 3201, 3200),
        ];
        let stays = merge_stays(&points);
        assert_eq!(stays.len(), 2);
        assert_eq!(
            (stays[0].first, stays[0].last),
            (TRAIL_START, TRAIL_START + 120)
        );
        assert_eq!(
            (stays[1].first, stays[1].last),
            (TRAIL_START + 180, TRAIL_START + 180)
        );
    }

    #[test]
    fn a_stay_is_not_merged_across_a_gap_in_the_data() {
        let points = vec![sample(0, 3200, 3200), sample(10, 3200, 3200)];
        assert_eq!(merge_stays(&points).len(), 2);
    }

    #[test]
    fn short_trails_are_not_thinned() {
        let built = thin_trail(merge_stays(&walk(0..50)), 1000);
        assert_eq!(built.points.len(), 50);
        assert_eq!((built.step, built.truncated), (60, false));
    }

    #[test]
    fn thinning_keeps_both_ends_of_a_teleport() {
        let mut points = walk(0..2500);
        // A teleport far away, then walking on from there.
        points.extend((2500..5000).map(|i| sample(i, 1500 + (i % 100) as i32, 3500)));
        let built = thin_trail(merge_stays(&points), 3000);
        assert!(built.points.len() <= 3000);
        assert!(built.step > 60 && !built.truncated);
        assert_eq!(built.points.first().unwrap().first, TRAIL_START);
        assert_eq!(built.points.last().unwrap().last, TRAIL_START + 4999 * 60);
        let landed = built
            .points
            .iter()
            .position(|point| point.first == TRAIL_START + 2500 * 60)
            .expect("the first point after the teleport is kept");
        assert_eq!(built.points[landed - 1].last, TRAIL_START + 2499 * 60);
    }

    #[test]
    fn thinning_keeps_both_sides_of_every_step_that_was_not_a_move() {
        // A tile a second, with something else than a move every 1500: none of
        // them further than a run, so only the label gives them away.
        let labels = [
            HubVia::Entrance,
            HubVia::House,
            HubVia::Teleport,
            HubVia::Gap,
            HubVia::Other,
        ];
        let points: Vec<HubLocationPoint> = (0..9000)
            .map(|i| {
                let via = match i % 1500 {
                    0 if i > 0 => labels[(i / 1500 - 1) as usize],
                    _ => HubVia::Move,
                };
                tick(i, 3000 + (i % 200) as i32, 3200 + (i / 200) as i32, via)
            })
            .collect();
        let built = thin_trail(merge_stays(&points), 3000);
        assert!(built.points.len() <= 3000 && !built.truncated);
        // Thinned by seconds, which is still nearer than a standing player's samples.
        assert_eq!(built.step, 60);
        for (index, via) in labels.iter().enumerate() {
            let landed = built
                .points
                .iter()
                .position(|point| point.via == Some(*via))
                .expect("the point after the step is kept");
            let at = TRAIL_START + (index as i64 + 1) * 1500;
            assert_eq!(built.points[landed].first, at);
            assert_eq!(built.points[landed - 1].last, at - 1, "{:?}", via);
        }
        // Between any other two points that were kept, only moves were left out.
        let moves = built
            .points
            .iter()
            .filter(|point| point.via == Some(HubVia::Move))
            .count();
        assert_eq!(moves, built.points.len() - labels.len());
    }

    #[test]
    fn a_labelled_run_is_thinned_like_any_walk() {
        // 190 tiles a minute: more than the old guess took for a run.
        let points: Vec<HubLocationPoint> = (0..5000)
            .map(|i| tick(i * 60, 1000 + (i * 190 % 2000) as i32, 3200, HubVia::Move))
            .collect();
        let stays = merge_stays(&points);
        assert!(stays.iter().all(|stay| !stay.jump));
        let built = thin_trail(stays, 3000);
        assert!(built.points.len() <= 3000 && !built.truncated);
        // A point a minute: more than half of them had to go.
        assert!(built.step > 60);
    }

    #[test]
    fn pages_join_into_one_trail_without_the_repeated_point() {
        // Newest first; each page starts with the last point of the one before it.
        let pages = vec![
            vec![
                tick(4, 3204, 3200, HubVia::Move),
                tick(5, 3600, 3200, HubVia::Teleport),
            ],
            vec![
                tick(2, 3202, 3200, HubVia::Teleport),
                tick(3, 3203, 3200, HubVia::Move),
                tick(4, 3204, 3200, HubVia::Move),
            ],
            vec![
                sample(0, 3200, 3200),
                tick(1, 2900, 3200, HubVia::Teleport),
                tick(2, 3202, 3200, HubVia::Teleport),
            ],
        ];
        let stays = join_pages(&pages);
        let xs: Vec<i32> = stays.iter().map(|stay| stay.x).collect();
        assert_eq!(xs, [3200, 2900, 3202, 3203, 3204, 3600]);
        let jumps: Vec<bool> = stays.iter().map(|stay| stay.jump).collect();
        assert_eq!(jumps, [false, true, true, false, false, true]);
        assert!(join_pages(&[Vec::new()]).is_empty());
    }

    /// The older part of a trail the hub gave in one page, read up to 100 s in.
    fn older(points: &[HubLocationPoint]) -> OlderTrail {
        let until = DateTime::from_timestamp(TRAIL_START + 100, 0).unwrap();
        older_part(&[copy(points)], until, false)
    }

    #[test]
    fn the_recent_part_follows_the_older_one() {
        let first = [
            tick(10, 3200, 3200, HubVia::Move),
            tick(20, 3201, 3200, HubVia::Move),
        ];
        // The answer starts with the point it was asked from, which has no label there.
        let recent = [
            HubLocationPoint {
                at: first[1].at,
                ..sample(0, 3201, 3200)
            },
            tick(80, 3201, 3200, HubVia::Move),
            tick(81, 2900, 3200, HubVia::Teleport),
        ];
        let built = join_recent(older(&first), &recent).built();
        let stays: Vec<(i32, i64, i64)> = built
            .points
            .iter()
            .map(|point| (point.x, point.first - TRAIL_START, point.last - TRAIL_START))
            .collect();
        // The stay on the last tile goes on; nothing is there twice.
        assert_eq!(stays, [(3200, 10, 10), (3201, 20, 80), (2900, 81, 81)]);
        assert!(built.points[2].jump);
        assert_eq!((built.step, built.truncated), (60, false));
    }

    #[test]
    fn a_trail_whose_older_part_was_cut_short_says_so() {
        let first = [
            tick(10, 3200, 3200, HubVia::Move),
            tick(20, 3201, 3200, HubVia::Move),
        ];
        let until = DateTime::from_timestamp(TRAIL_START + 100, 0).unwrap();
        // The hub had more than the pages that were read.
        let older = older_part(&[copy(&first)], until, true);
        assert!(older.trail.truncated);
        let recent = [tick(101, 3202, 3200, HubVia::Move)];
        assert!(join_recent(older, &recent).truncated);
        assert!(!join_recent(older_part(&[copy(&first)], until, false), &recent).truncated);
    }

    #[test]
    fn a_recent_part_read_before_the_older_one_adds_nothing_twice() {
        let first = [
            tick(10, 3200, 3200, HubVia::Move),
            tick(20, 3201, 3200, HubVia::Move),
        ];
        let stale = [
            tick(5, 3199, 3200, HubVia::Move),
            tick(10, 3200, 3200, HubVia::Move),
            tick(20, 3201, 3200, HubVia::Move),
            tick(21, 3202, 3200, HubVia::Move),
        ];
        let built = join_recent(older(&first), &stale);
        let xs: Vec<i32> = built.points.iter().map(|point| point.x).collect();
        assert_eq!(xs, [3200, 3201, 3202]);
        // Without any older point the recent part starts after `until`.
        let late = [
            tick(50, 3100, 3200, HubVia::Move),
            tick(101, 3101, 3200, HubVia::Move),
        ];
        let built = join_recent(older(&[]), &late);
        assert_eq!(built.points.len(), 1);
        assert_eq!(built.points[0].x, 3101);
    }

    #[test]
    fn thinning_keeps_boat_and_world_changes() {
        let mut points = walk(0..5000);
        for point in &mut points[1001..1500] {
            point.is_on_boat = Some(true);
        }
        for point in &mut points[3001..] {
            point.world = Some(330);
        }
        let built = thin_trail(merge_stays(&points), 3000);
        let times: HashSet<i64> = built.points.iter().map(|point| point.first).collect();
        for minute in [1000, 1001, 1499, 1500, 3000, 3001] {
            assert!(
                times.contains(&(TRAIL_START + minute * 60)),
                "minute {}",
                minute
            );
        }
    }

    #[test]
    fn thinning_keeps_both_sides_of_a_change_of_floor() {
        let mut points = walk(0..5000);
        // Up a ladder and down again further on: the same tiles, another floor.
        for point in &mut points[2001..2400] {
            point.plane = 1;
        }
        let built = thin_trail(merge_stays(&points), 3000);
        assert!(built.step > 60);
        let times: HashSet<i64> = built.points.iter().map(|point| point.first).collect();
        for minute in [2000, 2001, 2399, 2400] {
            assert!(
                times.contains(&(TRAIL_START + minute * 60)),
                "minute {}",
                minute
            );
        }
    }

    #[test]
    fn a_tile_the_player_stood_on_survives_thinning() {
        // Straight runs of 120 tiles, each with half a minute's stand halfway.
        let mut route = Route::from(3200, 3200);
        for trip in 0..150 {
            route.teleport(1700, 3505 + trip % 7);
            route.run(-1, 0, 60);
            route.stand(50);
            route.run(-1, 0, 60);
        }
        let stays = merge_stays(&route.points);
        let built = thin_trail(stays.clone(), 3000);
        assert!(built.points.len() < stays.len() / 2 && built.step == 60);
        // On a straight line it is the time that tells: the trail still has
        // the player on that tile until they ran on.
        let stood = built
            .points
            .windows(2)
            .filter(|pair| pair[0].x == 1640 && pair[1].x == 1638)
            .filter(|pair| pair[1].first - pair[0].last >= 29)
            .count();
        assert_eq!(stood, 150);
    }

    #[test]
    fn thinning_is_stable_as_the_window_slides() {
        let points = bank_trips(44);
        let earlier = thin_trail(merge_stays(&points[..16_000]), 3000);
        let later = thin_trail(merge_stays(&points[900..]), 3000);
        assert_eq!(earlier.step, later.step);
        // What lies between the first and the last break both windows have is
        // thinned to the same points in both.
        let from = later.points.iter().find(|point| point.jump).unwrap().first;
        let until = earlier
            .points
            .iter()
            .rfind(|point| point.jump)
            .unwrap()
            .first;
        let shared = |trail: &BuiltTrail| -> Vec<TrailPoint> {
            trail
                .points
                .iter()
                .filter(|point| point.first > from && point.first < until)
                .cloned()
                .collect()
        };
        assert!(shared(&earlier).len() > 1000);
        assert_eq!(shared(&earlier), shared(&later));
    }

    #[test]
    fn a_trail_of_only_teleports_is_cut_to_the_newest_points() {
        let points: Vec<HubLocationPoint> = (0..100)
            .map(|i| sample(i, if i % 2 == 0 { 1200 } else { 3200 }, 3200))
            .collect();
        let built = thin_trail(merge_stays(&points), 10);
        assert_eq!(built.points.len(), 10);
        assert!(built.truncated);
        assert_eq!(built.points.last().unwrap().last, TRAIL_START + 99 * 60);
    }

    #[test]
    fn trail_json_leaves_out_trailing_defaults_and_lists_world_changes() {
        let mut points = vec![
            sample(0, 3200, 3200),
            sample(1, 3201, 3200),
            sample(2, 3201, 3200),
            sample(3, 3202, 3200),
            sample(4, 3203, 3200),
        ];
        points[3].is_on_boat = Some(true);
        points[3].world = Some(330);
        points[4].world = Some(330);
        let json = trail_json("Zezima", &thin_trail(merge_stays(&points), 1000));
        assert_eq!(json["member"], "Zezima");
        assert_eq!(json["shared"], true);
        assert_eq!(json["step"], 60);
        assert_eq!(json["truncated"], false);
        assert_eq!(
            json["points"],
            serde_json::json!([
                [3200, 3200, 0, TRAIL_START],
                [3201, 3200, 0, TRAIL_START + 120, 60],
                [3202, 3200, 0, TRAIL_START + 180, 0, 1],
                [3203, 3200, 0, TRAIL_START + 240],
            ])
        );
        assert_eq!(json["worlds"], serde_json::json!([[0, 302], [2, 330]]));
    }

    #[test]
    fn trail_json_says_how_each_point_was_reached() {
        let points = vec![
            sample(0, 3200, 3200),
            tick(61, 3201, 3200, HubVia::Move),
            tick(62, 3201, 9600, HubVia::Entrance),
            tick(63, 1900, 7050, HubVia::Teleport),
            tick(64, 1960, 7050, HubVia::House),
            tick(600, 1960, 7050, HubVia::Gap),
            tick(601, 1961, 7050, HubVia::Other),
        ];
        let json = trail_json("Zezima", &thin_trail(merge_stays(&points), 1000));
        let codes: Vec<i64> = json["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|point| point.get(6).and_then(Value::as_i64).unwrap_or(0))
            .collect();
        assert_eq!(codes, [0, 1, 2, 4, 3, 5, 0]);
        assert_eq!(
            json["points"][1],
            serde_json::json!([3201, 3200, 0, TRAIL_START + 61, 0, 0, 1])
        );
    }
}
