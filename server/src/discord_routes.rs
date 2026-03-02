use crate::config::Config;
use crate::db;
use crate::error::ApiError;
use crate::models::{
    DiscordCallbackQuery, DiscordEnabledResponse, DiscordGuild, DiscordTokenResponse, DiscordUser,
};
use actix_web::{cookie, get, web, Error, HttpResponse};
use chrono::{Duration, Utc};
use deadpool_postgres::Pool;

const SESSION_DURATION_HOURS: i64 = 72;
const DISCORD_API_BASE: &str = "https://discord.com/api/v10";
const DISCORD_OAUTH_AUTHORIZE: &str = "https://discord.com/api/oauth2/authorize";
const DISCORD_OAUTH_TOKEN: &str = "https://discord.com/api/oauth2/token";
const MAX_USERNAME_LEN: usize = 32;
const MAX_USERNAME_CREATION_ATTEMPTS: usize = 10;
// Reserve space for suffix like "_1234"
const MAX_USERNAME_PREFIX_LEN: usize = MAX_USERNAME_LEN - 5;

#[get("/discord/enabled")]
pub async fn discord_enabled(config: web::Data<Config>) -> Result<HttpResponse, Error> {
    if !config.discord.enabled {
        return Ok(HttpResponse::Ok().json(DiscordEnabledResponse {
            enabled: false,
            auth_url: None,
        }));
    }

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope=identify%20guilds",
        DISCORD_OAUTH_AUTHORIZE,
        config.discord.client_id,
        urlencoding::encode(&config.discord.redirect_uri),
    );

    Ok(HttpResponse::Ok().json(DiscordEnabledResponse {
        enabled: true,
        auth_url: Some(auth_url),
    }))
}

#[get("/discord/callback")]
pub async fn discord_callback(
    query: web::Query<DiscordCallbackQuery>,
    db_pool: web::Data<Pool>,
    config: web::Data<Config>,
) -> Result<HttpResponse, Error> {
    if !config.discord.enabled {
        return Ok(HttpResponse::BadRequest().body("Discord authentication is not enabled"));
    }

    // Exchange the authorization code for an access token
    let http_client = reqwest::Client::new();
    let token_response = http_client
        .post(DISCORD_OAUTH_TOKEN)
        .form(&[
            ("client_id", config.discord.client_id.as_str()),
            ("client_secret", config.discord.client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", &query.code),
            ("redirect_uri", config.discord.redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(ApiError::ReqwestError)?;

    if !token_response.status().is_success() {
        log::error!(
            "Discord token exchange failed: {}",
            token_response.status()
        );
        return Ok(HttpResponse::BadRequest().body("Failed to authenticate with Discord"));
    }

    let token_data: DiscordTokenResponse = token_response
        .json()
        .await
        .map_err(ApiError::ReqwestError)?;

    // Fetch Discord user info
    let discord_user: DiscordUser = http_client
        .get(&format!("{}/users/@me", DISCORD_API_BASE))
        .header(
            "Authorization",
            format!("{} {}", token_data.token_type, token_data.access_token),
        )
        .send()
        .await
        .map_err(ApiError::ReqwestError)?
        .json()
        .await
        .map_err(ApiError::ReqwestError)?;

    let db_client = db_pool.get().await.map_err(ApiError::PoolError)?;

    // Check if Discord user already has a linked account
    if let Some((user_id, username, _role, enabled)) =
        db::get_user_by_discord_id(&db_client, &discord_user.id).await?
    {
        if !enabled {
            return Ok(HttpResponse::Unauthorized().body("Account is disabled"));
        }

        // Existing user - create session and log in
        let _ = db::cleanup_expired_sessions(&db_client).await;
        let session_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let expires_at = Utc::now() + Duration::hours(SESSION_DURATION_HOURS);
        db::create_session(&db_client, &session_id, user_id, &expires_at).await?;

        db::write_audit_log(
            &db_client,
            Some(user_id),
            "discord_login",
            None,
            Some(&format!(
                "User '{}' logged in via Discord (discord_id: {})",
                username, discord_user.id
            )),
        )
        .await?;

        let cookie = cookie::Cookie::build("session", session_id.clone())
            .path("/")
            .http_only(true)
            .same_site(cookie::SameSite::Lax)
            .max_age(cookie::time::Duration::hours(SESSION_DURATION_HOURS))
            .finish();

        return Ok(HttpResponse::Found()
            .cookie(cookie)
            .append_header(("Location", "/group"))
            .finish());
    }

    // No existing link - check if auto-registration is allowed
    if !config.discord.auto_registration {
        return Ok(HttpResponse::Forbidden()
            .body("Auto-registration is disabled. Contact an admin to create your account."));
    }

    // Fetch user's guilds to check membership
    let guilds: Vec<DiscordGuild> = http_client
        .get(&format!("{}/users/@me/guilds", DISCORD_API_BASE))
        .header(
            "Authorization",
            format!("{} {}", token_data.token_type, token_data.access_token),
        )
        .send()
        .await
        .map_err(ApiError::ReqwestError)?
        .json()
        .await
        .map_err(ApiError::ReqwestError)?;

    // Check if user is in any allowed server
    let user_guild_ids: Vec<&str> = guilds.iter().map(|g| g.id.as_str()).collect();
    let is_in_allowed_server = config
        .discord
        .autoreg_servers
        .iter()
        .any(|allowed| user_guild_ids.contains(&allowed.as_str()));

    if !is_in_allowed_server {
        return Ok(HttpResponse::Forbidden().body(
            "You are not a member of any allowed Discord server for auto-registration.",
        ));
    }

    // Auto-register: create a new user account
    let display_name = discord_user
        .global_name
        .as_deref()
        .unwrap_or(&discord_user.username);
    // Sanitize username: only keep alphanumeric, underscore, hyphen; truncate to 32 chars
    let sanitized: String = display_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .take(MAX_USERNAME_LEN)
        .collect();
    let base_username = if sanitized.is_empty() {
        format!("discord_{}", &discord_user.id[..8.min(discord_user.id.len())])
    } else {
        sanitized
    };

    // Try to create user, appending suffix if username is taken
    let mut username = base_username.clone();
    let mut user_id: Option<i64> = None;
    for attempt in 0..MAX_USERNAME_CREATION_ATTEMPTS {
        match db::create_user_no_password(&db_client, &username, "member").await {
            Ok(id) => {
                user_id = Some(id);
                break;
            }
            Err(_) if attempt < MAX_USERNAME_CREATION_ATTEMPTS - 1 => {
                let suffix = &discord_user.id
                    [discord_user.id.len().saturating_sub(4)..];
                username = format!("{}_{}", &base_username[..base_username.len().min(MAX_USERNAME_PREFIX_LEN)], suffix);
            }
            Err(e) => return Err(e.into()),
        }
    }

    let user_id = user_id.ok_or_else(|| {
        ApiError::BadRequest("Could not create unique username".to_string())
    })?;

    // Link Discord account
    db::create_discord_user_link(&db_client, &discord_user.id, user_id, &discord_user.username)
        .await?;

    // Write audit log
    let matched_servers: Vec<&str> = config
        .discord
        .autoreg_servers
        .iter()
        .filter(|s| user_guild_ids.contains(&s.as_str()))
        .map(|s| s.as_str())
        .collect();

    db::write_audit_log(
        &db_client,
        Some(user_id),
        "discord_auto_register",
        Some(user_id),
        Some(&format!(
            "User '{}' auto-registered via Discord (discord_id: {}, discord_user: {}, matched_servers: {:?})",
            username, discord_user.id, discord_user.username, matched_servers
        )),
    )
    .await?;

    // Create session for the new user
    let session_id = uuid::Uuid::new_v4().hyphenated().to_string();
    let expires_at = Utc::now() + Duration::hours(SESSION_DURATION_HOURS);
    db::create_session(&db_client, &session_id, user_id, &expires_at).await?;

    let cookie = cookie::Cookie::build("session", session_id.clone())
        .path("/")
        .http_only(true)
        .same_site(cookie::SameSite::Lax)
        .max_age(cookie::time::Duration::hours(SESSION_DURATION_HOURS))
        .finish();

    Ok(HttpResponse::Found()
        .cookie(cookie)
        .append_header(("Location", "/group"))
        .finish())
}
