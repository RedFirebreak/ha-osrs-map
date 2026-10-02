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
/// Trails requested at once; more lines than this are unreadable anyway.
pub(crate) const MAX_TRAILS: usize = 8;

/// A player standing still keeps one point a minute, so the points of a trail
/// that wasn't thinned are never further apart than this without a gap.
const TRAIL_IDLE_SECS: i64 = 60;
/// Samples further apart than this are a gap in the data (logged out, or not sharing).
const TRAIL_GAP_SECS: i64 = 300;
/// Running covers two tiles per 0.6 s game tick.
const RUN_TILES_PER_SEC: f64 = 2.0 / 0.6;
/// The strides (in seconds) tried in turn when a trail has too many points.
const THIN_STRIDES_SECS: [i64; 17] = [
    2, 5, 10, 20, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600,
];
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

/// A trail ready to send: `step` is the longest time between two points that
/// isn't a gap (a minute when nothing was thinned, else the thinning stride);
/// `truncated` when the trail was too long and its oldest points were dropped.
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

/// Thins a long trail to at most `max_points`: the first point of every
/// `step` seconds (on a fixed grid, so the result barely changes as the window
/// slides), plus the ends of the trail and both sides of every break.
pub(crate) fn thin_trail(points: Vec<TrailPoint>, max_points: usize) -> BuiltTrail {
    if points.len() <= max_points || max_points < 2 {
        return BuiltTrail {
            points,
            step: TRAIL_IDLE_SECS,
            truncated: false,
        };
    }
    let mut protected = vec![false; points.len()];
    protected[0] = true;
    protected[points.len() - 1] = true;
    for i in 1..points.len() {
        if points[i].jump {
            protected[i - 1] = true;
            protected[i] = true;
        }
    }

    let mut keep = Vec::new();
    let mut kept = 0;
    let mut step = TRAIL_IDLE_SECS;
    for stride in THIN_STRIDES_SECS {
        step = stride.max(TRAIL_IDLE_SECS);
        let mut bucket = None;
        keep = points
            .iter()
            .zip(&protected)
            .map(|(point, protected)| {
                let first_of_bucket = bucket.replace(point.first.div_euclid(stride))
                    != Some(point.first.div_euclid(stride));
                *protected || first_of_bucket
            })
            .collect();
        kept = keep.iter().filter(|keep| **keep).count();
        if kept <= max_points {
            break;
        }
    }

    let truncated = kept > max_points;
    let mut drop = kept.saturating_sub(max_points);
    let points = points
        .into_iter()
        .zip(keep)
        .filter(|(_, keep)| *keep)
        .map(|(point, _)| point)
        .skip_while(|_| {
            let dropping = drop > 0;
            drop = drop.saturating_sub(1);
            dropping
        })
        .collect();
    BuiltTrail {
        points,
        step,
        truncated,
    }
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
/// that a month of ticks isn't held in memory.
#[derive(Serialize, Deserialize)]
struct OlderTrail {
    /// The hub was asked for the points up to this time.
    until: DateTime<Utc>,
    /// The time of the last of them, where the recent part takes over.
    last_at: Option<DateTime<Utc>>,
    trail: BuiltTrail,
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

/// The older part followed by what the hub has had since. `recent` was asked
/// for from the older part's last point on, so it starts with that point (or
/// with more that the older part already has, when it comes from the cache).
fn join_recent(older: OlderTrail, recent: &[HubLocationPoint]) -> BuiltTrail {
    let from = older.last_at.unwrap_or(older.until);
    let known = recent.partition_point(|point| point.at <= from);
    let mut stays = older.trail.points;
    extend_stays(&mut stays, &recent[known..]);
    let mut built = thin_trail(stays, MAX_TRAIL_POINTS);
    built.step = built.step.max(older.trail.step);
    built.truncated |= older.trail.truncated;
    built
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
    let last_at = pages
        .first()
        .and_then(|page| page.last())
        .map(|point| point.at);
    let mut trail = thin_trail(join_pages(&pages), MAX_TRAIL_POINTS);
    trail.truncated |= truncated;
    serde_json::to_value(OlderTrail {
        until,
        last_at,
        trail,
    })
    .map_err(|err| HubError::Other(err.to_string()))
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
    Ok(Some((join_recent(older, &recent.points), age)))
}

#[get("/hub/trails")]
pub async fn get_trails(
    _auth: Authenticated,
    query: web::Query<TrailsQuery>,
    config: web::Data<Config>,
    context: web::Data<HubContext>,
) -> Result<HttpResponse, HistoryError> {
    history_enabled(&config)?;
    let days = query.days.unwrap_or(1).clamp(1, 30);
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
        assert!(built.points.len() <= 2501);
        assert_eq!(built.step, 120);
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

    fn older(points: &[HubLocationPoint], step: i64) -> OlderTrail {
        OlderTrail {
            until: DateTime::from_timestamp(TRAIL_START + 100, 0).unwrap(),
            last_at: points.last().map(|point| point.at),
            trail: BuiltTrail {
                points: merge_stays(points),
                step,
                truncated: false,
            },
        }
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
        let built = join_recent(older(&first, 600), &recent);
        let stays: Vec<(i32, i64, i64)> = built
            .points
            .iter()
            .map(|point| (point.x, point.first - TRAIL_START, point.last - TRAIL_START))
            .collect();
        // The stay on the last tile goes on; nothing is there twice.
        assert_eq!(stays, [(3200, 10, 10), (3201, 20, 80), (2900, 81, 81)]);
        assert!(built.points[2].jump);
        // The older part was thinned to ten minutes, and the trail says so.
        assert_eq!(built.step, 600);
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
        let built = join_recent(older(&first, 60), &stale);
        let xs: Vec<i32> = built.points.iter().map(|point| point.x).collect();
        assert_eq!(xs, [3200, 3201, 3202]);
        // Without any older point the recent part starts after `until`.
        let late = [
            tick(50, 3100, 3200, HubVia::Move),
            tick(101, 3101, 3200, HubVia::Move),
        ];
        let built = join_recent(older(&[], 60), &late);
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
    fn thinning_is_stable_as_the_window_slides() {
        let earlier = thin_trail(merge_stays(&walk(0..5000)), 3000);
        let later = thin_trail(merge_stays(&walk(120..5120)), 3000);
        assert_eq!(earlier.step, later.step);
        let known: HashSet<i64> = earlier.points.iter().map(|point| point.first).collect();
        // The window's own first and last points aside, the same samples are kept.
        let shared = &later.points[1..later.points.len() - 1];
        let moved = shared
            .iter()
            .filter(|point| point.first < TRAIL_START + 5000 * 60 - later.step)
            .filter(|point| !known.contains(&point.first))
            .count();
        assert_eq!(moved, 0);
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
