//! The guild's leaderboards from the hub: who gained the most XP, and the
//! most valuable drops.
use crate::auth_middleware::Authenticated;
use crate::config::Config;
use crate::hub::client::HubError;
use crate::hub::events::{event_json, EventFilter};
use crate::hub::fetch::{fetch_value, history_enabled, hub_error_response, parse};
use crate::hub::models::{HubEvent, HubLeaderboards, HubLootLeaderboard};
use crate::hub::HubContext;
use actix_web::{get, web, Error, HttpResponse};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

const GAINS_TTL: Duration = Duration::from_secs(300);
const LOOT_TTL: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
pub struct GainsQuery {
    #[serde(default)]
    period: Option<String>,
}

#[get("/hub/gains")]
pub async fn get_gains(
    _auth: Authenticated,
    query: web::Query<GainsQuery>,
    config: web::Data<Config>,
    context: web::Data<HubContext>,
) -> Result<HttpResponse, Error> {
    if let Err(response) = history_enabled(&config) {
        return Ok(response);
    }
    let period = match query.period.as_deref().unwrap_or("day") {
        period @ ("day" | "week" | "month") => period.to_owned(),
        _ => return Ok(HttpResponse::BadRequest().body("period must be day, week or month")),
    };
    let client = Arc::clone(&context.client);
    let value = context
        .cache
        .get_or_fetch(&format!("gains:{}", period), GAINS_TTL, || async {
            fetch_value::<Value>(
                &client,
                "/leaderboards/gains",
                &[("period", period.clone())],
            )
            .await
        })
        .await;
    let leaderboards = match value.and_then(|value| parse::<HubLeaderboards>(&value)) {
        Ok(leaderboards) => leaderboards,
        Err(err) => return Ok(hub_error_response(err)),
    };

    let directory = &context.directory;
    let boards: Vec<Value> = leaderboards
        .leaderboards
        .into_iter()
        .map(|board| {
            let entries: Vec<Value> = board
                .entries
                .into_iter()
                .filter(|entry| !directory.is_hidden(&entry.account.id))
                .map(|entry| {
                    serde_json::json!({
                        "rank": entry.rank,
                        "name": directory.member_name(&entry.account.id).unwrap_or(entry.account.name),
                        "gain": entry.gain,
                    })
                })
                .collect();
            serde_json::json!({ "skill": board.skill, "entries": entries })
        })
        .collect();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "period": leaderboards.period,
        "leaderboards": boards,
    })))
}

#[derive(Deserialize)]
pub struct LootQuery {
    #[serde(default)]
    period: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// The period's most valuable drops. Falls back to the buffered events (marked
/// `partial`) when the hub predates `/leaderboards/loot`.
#[get("/hub/leaderboards/loot")]
pub async fn get_loot_leaderboard(
    _auth: Authenticated,
    query: web::Query<LootQuery>,
    config: web::Data<Config>,
    context: web::Data<HubContext>,
) -> Result<HttpResponse, Error> {
    if let Err(response) = history_enabled(&config) {
        return Ok(response);
    }
    let period = match query.period.as_deref().unwrap_or("week") {
        period @ ("day" | "week" | "month") => period.to_owned(),
        _ => return Ok(HttpResponse::BadRequest().body("period must be day, week or month")),
    };
    let limit = query.limit.unwrap_or(10).clamp(1, 50);
    let client = Arc::clone(&context.client);
    let value = context
        .cache
        .get_or_fetch(&format!("loot:{}", period), LOOT_TTL, || async {
            fetch_value::<Value>(
                &client,
                "/leaderboards/loot",
                &[("period", period.clone()), ("limit", "50".to_string())],
            )
            .await
        })
        .await;
    let directory = &context.directory;
    let (events, partial): (Vec<HubEvent>, bool) =
        match value.and_then(|value| parse::<HubLootLeaderboard>(&value)) {
            Ok(board) => (
                board.entries.into_iter().map(|entry| entry.event).collect(),
                false,
            ),
            Err(HubError::NotFound) => (loot_from_buffer(&context, &period), true),
            Err(err) => return Ok(hub_error_response(err)),
        };
    let entries: Vec<Value> = events
        .iter()
        .filter(|event| !directory.is_hidden(&event.account.id))
        .take(limit)
        .enumerate()
        .map(|(index, event)| {
            serde_json::json!({ "rank": index + 1, "event": event_json(None, event, directory) })
        })
        .collect();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "period": period,
        "partial": partial,
        "entries": entries,
    })))
}

/// The most valuable buffered drops of the period, for hubs without the loot leaderboard.
fn loot_from_buffer(context: &HubContext, period: &str) -> Vec<HubEvent> {
    let since = Utc::now()
        - match period {
            "day" => ChronoDuration::days(1),
            "week" => ChronoDuration::days(7),
            _ => ChronoDuration::days(30),
        };
    let types = ["loot".to_string(), "pk_loot".to_string()];
    let filter = EventFilter {
        types: &types,
        ..Default::default()
    };
    let mut events: Vec<HubEvent> = context
        .events
        .query(&filter, usize::MAX)
        .into_iter()
        .map(|buffered| buffered.event)
        .filter(|event| {
            event.occurred_at >= since
                && event.value_gp.is_some()
                && !event.special_world.unwrap_or(false)
        })
        .collect();
    events.sort_by_key(|event| std::cmp::Reverse((event.value_gp, event.occurred_at)));
    events
}
