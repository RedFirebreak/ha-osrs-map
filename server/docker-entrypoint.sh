#!/bin/bash

CONFIG_FILE=config.toml

echo "[entrypoint] Creating $CONFIG_FILE"
if [ -e $CONFIG_FILE ]
then
  echo "[entrypoint] $CONFIG_FILE already exists, deleting and starting fresh"
  rm $CONFIG_FILE
fi

echo "[pg]" >> $CONFIG_FILE
echo "user = \"$PG_USER\"" >> $CONFIG_FILE
echo "password = \"$PG_PASSWORD\"" >> $CONFIG_FILE
echo "host = \"$PG_HOST\"" >> $CONFIG_FILE
echo "port = $PG_PORT" >> $CONFIG_FILE
echo "dbname = \"$PG_DB\"" >> $CONFIG_FILE
echo "pool.max_size = 16" >> $CONFIG_FILE

# Discord OAuth config
if [ -n "$DISCORD_CLIENT_ID" ]; then
  echo "" >> $CONFIG_FILE
  echo "[discord]" >> $CONFIG_FILE
  echo "enabled = true" >> $CONFIG_FILE
  echo "client_id = \"$DISCORD_CLIENT_ID\"" >> $CONFIG_FILE
  echo "client_secret = \"$DISCORD_CLIENT_SECRET\"" >> $CONFIG_FILE
  echo "redirect_uri = \"$DISCORD_REDIRECT_URI\"" >> $CONFIG_FILE
  echo "auto_registration = ${DISCORD_AUTO_REGISTRATION:-false}" >> $CONFIG_FILE
  if [ -n "$DISCORD_AUTOREG_SERVERS" ]; then
    IFS=',' read -ra SERVERS <<< "$DISCORD_AUTOREG_SERVERS"
    echo -n "autoreg_servers = [" >> $CONFIG_FILE
    first=true
    for server in "${SERVERS[@]}"; do
      server=$(echo "$server" | xargs)
      if [ "$first" = true ]; then
        first=false
      else
        echo -n ", " >> $CONFIG_FILE
      fi
      echo -n "\"$server\"" >> $CONFIG_FILE
    done
    echo "]" >> $CONFIG_FILE
  fi
fi

SECRET_FILE=secret

echo "[entrypoint] Creating $SECRET_FILE"
if [ -e $SECRET_FILE ]
then
  echo "[entrypoint] $SECRET_FILE already exists, deleting and starting fresh"
  rm $SECRET_FILE
fi
echo "$BACKEND_SECRET" >> $SECRET_FILE

echo "[entrypoint] Running run"
exec "$@"
