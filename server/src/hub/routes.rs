//! Feature flags for the site and the admin view of the hub connection.
use crate::auth_middleware::{AdminAuthenticated, Authenticated};
use crate::config::Config;
use crate::hub::client::{HubError, Priority};
use crate::hub::models::HubMe;
use crate::hub::HubContext;
use actix_web::{get, post, web, Error, HttpResponse};

/// Whether the site should show the hub-backed history (graphs, trails, events).
#[get("/features")]
pub async fn get_features(
    _auth: Authenticated,
    config: web::Data<Config>,
) -> Result<HttpResponse, Error> {
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "hub_history": config.hub_history_enabled(),
    })))
}

#[get("/hub/status")]
pub async fn get_hub_status(
    _admin: AdminAuthenticated,
    context: web::Data<HubContext>,
) -> Result<HttpResponse, Error> {
    let status = context
        .status
        .read()
        .map(|status| status.clone())
        .unwrap_or_default();
    Ok(HttpResponse::Ok().json(status))
}

/// Checks the API key against the hub's `/me`.
#[post("/hub/test")]
pub async fn test_hub_connection(
    _admin: AdminAuthenticated,
    context: web::Data<HubContext>,
) -> Result<HttpResponse, Error> {
    let response = match context
        .client
        .get_data::<HubMe>("/me", &[], Priority::Sync)
        .await
    {
        Ok((me, _)) => serde_json::json!({
            "ok": true,
            "key": me.key,
            "visible_accounts": me.visible_accounts,
        }),
        Err(HubError::Unauthorized) => serde_json::json!({
            "ok": false,
            "message": "The hub rejected the API key. It may be revoked or expired."
        }),
        Err(err) => serde_json::json!({ "ok": false, "message": err.to_string() }),
    };
    Ok(HttpResponse::Ok().json(response))
}

/// How long the hub's place names are kept: they change only with a hub release.
const REGIONS_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// The place names of the game's map regions, as the hub names them (its public
/// `/regions.json`, hub D-138), so the map and the hub name a place the same way from
/// one table. Public like the hub's own: the names are RuneLite's, not guild data,
/// and the login page loads them too. A hub without the table answers 404, and the
/// site falls back to the places it works out from the coordinates.
#[get("/regions")]
pub async fn get_regions(context: web::Data<HubContext>) -> Result<HttpResponse, Error> {
    let client = std::sync::Arc::clone(&context.client);
    let found = context
        .cache
        .get_or_fetch("regions", REGIONS_TTL, || async move {
            client.get_public("/regions.json").await
        })
        .await;
    Ok(match found {
        Ok(value) => HttpResponse::Ok()
            .insert_header(("Cache-Control", "public, max-age=3600"))
            .json(value.as_ref()),
        Err(HubError::NotFound) => HttpResponse::NotFound().json(serde_json::json!({
            "message": "The hub has no place names (it is older than osrs-data-hub's regions.json)."
        })),
        Err(err) => {
            log::warn!("place names from the hub: {}", err);
            HttpResponse::ServiceUnavailable()
                .json(serde_json::json!({ "message": "The hub's place names are unavailable." }))
        }
    })
}
