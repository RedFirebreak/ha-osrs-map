//! What the handlers that serve the hub's history share. The hub API key
//! stays on the server; responses are cached (see `cache.rs`) so the number of
//! hub requests does not grow with the number of viewers.
use crate::config::Config;
use crate::hub::client::{HubClient, HubError, Priority};
use crate::hub::HubContext;
use actix_web::HttpResponse;
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn hub_error_response(err: HubError) -> HttpResponse {
    match err {
        HubError::NotFound => HttpResponse::NotFound().json(serde_json::json!({
            "error": "not_available",
            "message": "This data is not available from the hub."
        })),
        HubError::RateLimited(after) => HttpResponse::ServiceUnavailable()
            .insert_header(("Retry-After", after.as_secs().max(1).to_string()))
            .json(serde_json::json!({
                "error": "rate_limited",
                "message": "The hub is busy, try again shortly."
            })),
        HubError::Invalid(message) => {
            log::warn!("The hub rejected a request: {}", message);
            HttpResponse::BadGateway().json(serde_json::json!({
                "error": "hub_rejected",
                "message": "The hub rejected the request."
            }))
        }
        HubError::Unauthorized => {
            log::error!("The hub rejected the API key; check HUB_API_KEY");
            HttpResponse::BadGateway().json(serde_json::json!({
                "error": "hub_unauthorized",
                "message": "The hub rejected this server's API key."
            }))
        }
        HubError::Other(message) => {
            log::warn!("Hub request failed: {}", message);
            HttpResponse::BadGateway().json(serde_json::json!({
                "error": "hub_unavailable",
                "message": "The hub could not be reached."
            }))
        }
    }
}

pub(crate) fn history_enabled(config: &Config) -> Result<(), HttpResponse> {
    if config.hub_history_enabled() {
        Ok(())
    } else {
        Err(HttpResponse::NotFound().json(serde_json::json!({
            "error": "hub_disabled",
            "message": "Hub history is not enabled on this server."
        })))
    }
}

pub(crate) async fn fetch_value<
    T: serde::de::DeserializeOwned + serde::Serialize + Send + 'static,
>(
    client: &Arc<HubClient>,
    path: &str,
    query: &[(&str, String)],
) -> Result<Value, HubError> {
    let (data, _) = client
        .get_data::<T>(path, query, Priority::Interactive)
        .await?;
    serde_json::to_value(data).map_err(|err| HubError::Other(err.to_string()))
}

/// Parses a cached hub response into its type.
pub(crate) fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, HubError> {
    serde_json::from_value(value.clone()).map_err(|err| HubError::Other(err.to_string()))
}

/// The hub accounts to request at once, per the key's kind.
pub(crate) fn bulk_accounts(context: &HubContext) -> usize {
    context
        .capabilities
        .read()
        .map(|capabilities| capabilities.bulk_accounts)
        .unwrap_or(crate::hub::USER_KEY_BULK_ACCOUNTS)
        .max(1)
}

/// A comma-separated list parameter.
pub(crate) fn list_param(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_params_are_trimmed() {
        assert_eq!(list_param(Some(" a, b ,,c")), vec!["a", "b", "c"]);
        assert!(list_param(None).is_empty());
    }
}
