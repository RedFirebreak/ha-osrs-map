use crate::crypto::token_hash;
use crate::db;
use crate::error::ApiError;
use crate::auth_middleware::Authenticated;
use crate::models::{
    GroupMember, IngestPayload, PairCodeResponse, PairRequest, PairResponse,
};
use crate::validators::valid_name;
use actix_web::{post, web, Error, HttpRequest, HttpResponse};
use chrono::{Duration, Utc};
use deadpool_postgres::{Client, Pool};
use tokio::sync::mpsc;

const SKILL_ORDER: &[&str] = &[
    "Attack", "Defence", "Strength", "Hitpoints", "Ranged", "Prayer",
    "Magic", "Cooking", "Woodcutting", "Fletching", "Fishing", "Firemaking",
    "Crafting", "Smithing", "Mining", "Herblore", "Agility", "Thieving",
    "Slayer", "Farming", "Runecraft", "Hunter", "Construction",
];

fn generate_pairing_code() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let code: u32 = rng.random_range(10000..100000);
    code.to_string()
}

#[post("/pair/code")]
pub async fn create_pairing_code(
    auth: Authenticated,
    db_pool: web::Data<Pool>,
) -> Result<HttpResponse, Error> {
    let client: Client = db_pool.get().await.map_err(ApiError::PoolError)?;

    // Clean up expired codes
    let _ = db::cleanup_expired_pairing_codes(&client).await;

    let code = generate_pairing_code();
    let expires_at = Utc::now() + Duration::seconds(300);

    db::store_pairing_code(&client, &code, auth.group_id, &expires_at).await?;

    Ok(HttpResponse::Ok().json(PairCodeResponse {
        ok: true,
        code,
        expires_in: 300,
    }))
}

#[post("/pair")]
pub async fn pair_device(
    body: web::Json<PairRequest>,
    db_pool: web::Data<Pool>,
) -> Result<HttpResponse, Error> {
    let client: Client = db_pool.get().await.map_err(ApiError::PoolError)?;

    let group_id = db::consume_pairing_code(&client, &body.code).await?;
    let group_name = db::get_group_name_by_id(&client, group_id).await?;

    let device_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let raw_token = uuid::Uuid::new_v4().hyphenated().to_string();
    let hashed_token = token_hash(&raw_token, &group_name);

    db::store_device(&client, &device_id, group_id, &hashed_token).await?;

    Ok(HttpResponse::Ok().json(PairResponse {
        ok: true,
        device_id,
        token: raw_token,
    }))
}

fn convert_ingest_to_group_member(payload: &IngestPayload, group_id: i64) -> GroupMember {
    let player = &payload.player;

    let coordinates = player.location.as_ref().map(|loc| vec![loc.x, loc.y, loc.plane]);

    let stats = match (&player.health, &player.prayer_points) {
        (Some(health), Some(prayer)) => Some(vec![
            health.current, health.max,
            0,
            prayer.current, prayer.max,
            0, 0,
        ]),
        (Some(health), None) => Some(vec![health.current, health.max, 0, 0, 0, 0, 0]),
        _ => None,
    };

    let skills = player.stats.as_ref().and_then(|stats| {
        stats.skills.as_ref().map(|skill_map| {
            SKILL_ORDER
                .iter()
                .map(|name| {
                    skill_map
                        .get(*name)
                        .and_then(|s| s.xp)
                        .unwrap_or(0)
                })
                .collect()
        })
    });

    let inventory = player.inventory.as_ref().and_then(|inv| {
        inv.items.as_ref().map(|items| {
            let mut flat = Vec::with_capacity(56);
            for item in items.iter().take(28) {
                flat.push(item.id.unwrap_or(0));
                flat.push(item.quantity.unwrap_or(0));
            }
            while flat.len() < 56 {
                flat.push(0);
            }
            flat
        })
    });

    let equipment = player.equipment.as_ref().and_then(|eq| {
        eq.items.as_ref().map(|items| {
            let mut flat = Vec::with_capacity(28);
            for item in items.iter().take(14) {
                flat.push(item.id.unwrap_or(0));
                flat.push(item.quantity.unwrap_or(0));
            }
            while flat.len() < 28 {
                flat.push(0);
            }
            flat
        })
    });

    GroupMember {
        group_id: Some(group_id),
        name: player.name.clone(),
        stats,
        coordinates,
        skills,
        quests: None,
        inventory,
        equipment,
        bank: None,
        shared_bank: None,
        rune_pouch: None,
        interacting: None,
        seed_vault: None,
        deposited: None,
        diary_vars: None,
        collection_log_v2: None,
        last_updated: None,
    }
}

#[post("/group/{group_name}/ingest")]
pub async fn ingest(
    req: HttpRequest,
    body: web::Json<IngestPayload>,
    db_pool: web::Data<Pool>,
    sender: web::Data<mpsc::Sender<GroupMember>>,
) -> Result<HttpResponse, Error> {
    let token = match req.headers().get("X-Osrs-Token") {
        Some(header) => match header.to_str() {
            Ok(t) => t,
            Err(_) => {
                return Ok(HttpResponse::BadRequest().body("Invalid X-Osrs-Token header"));
            }
        },
        None => {
            return Ok(HttpResponse::Unauthorized().body("X-Osrs-Token header required"));
        }
    };

    let group_name = match req.match_info().get("group_name") {
        Some(name) => name,
        None => {
            return Ok(HttpResponse::BadRequest().body("Missing group name"));
        }
    };

    let client: Client = db_pool.get().await.map_err(ApiError::PoolError)?;

    let hashed_token = token_hash(token, group_name);
    let group_id = db::get_device_group(&client, &hashed_token).await?;

    let player_name = &body.player.name;
    if !valid_name(player_name) {
        return Ok(HttpResponse::BadRequest().body(format!("Invalid player name: {}", player_name)));
    }

    db::ensure_member_exists(&client, group_id, player_name).await?;

    let group_member = convert_ingest_to_group_member(&body, group_id);

    match sender.send(group_member).await {
        Ok(_) => Ok(HttpResponse::Ok().json(serde_json::json!({"ok": true}))),
        Err(_) => Ok(HttpResponse::InternalServerError().body("Failed to submit player update")),
    }
}
