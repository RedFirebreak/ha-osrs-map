use config::{ConfigError, File};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}
impl LogLevel {
    pub fn to_string(&self) -> &'static str {
        match self {
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}
#[derive(Deserialize, Clone)]
pub struct LoggerConfig {
    pub level: LogLevel,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct CaptchaConfig {
    pub enabled: bool,
    pub sitekey: String,
    #[serde(skip_serializing)]
    pub secret: String,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct DiscordConfig {
    pub enabled: bool,
    #[serde(skip_serializing)]
    pub client_id: String,
    #[serde(skip_serializing)]
    pub client_secret: String,
    pub redirect_uri: String,
    pub auto_registration: bool,
    #[serde(default)]
    pub autoreg_servers: Vec<String>,
}
#[derive(Deserialize, Clone)]
pub struct Config {
    pub pg: deadpool_postgres::Config,
    #[serde(default = "default_logger_config")]
    pub logger: LoggerConfig,
    #[serde(default = "default_captcha_config")]
    pub hcaptcha: CaptchaConfig,
    #[serde(default = "default_discord_config")]
    pub discord: DiscordConfig,
}
fn default_logger_config() -> LoggerConfig {
    LoggerConfig {
        level: LogLevel::Info,
    }
}
fn default_captcha_config() -> CaptchaConfig {
    CaptchaConfig {
        enabled: false,
        sitekey: "".to_string(),
        secret: "".to_string(),
    }
}
fn default_discord_config() -> DiscordConfig {
    DiscordConfig {
        enabled: false,
        client_id: "".to_string(),
        client_secret: "".to_string(),
        redirect_uri: "".to_string(),
        auto_registration: false,
        autoreg_servers: vec![],
    }
}
impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let cfg = ::config::Config::builder()
            .add_source(File::with_name("config"))
            .build()?;
        cfg.try_deserialize()
    }
}
