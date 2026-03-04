# OSRS Group Tracker

![Rust](https://img.shields.io/badge/Rust-CE422B?style=for-the-badge&logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-336791?style=for-the-badge&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)

Real-time tracking and group coordination tool for Old School RuneScape players.

Track your group members' activities in real-time: inventory, equipment, bank, skill XP, world position, HP/Prayer/Energy, quests, and more!

## 📦 What This Tracks

- 🎒 **Inventory, Equipment & Bank** — See what items your team has
- 📊 **Skill Experience** — Monitor XP gains across all skills
- 🗺️ **World Position** — Interactive map showing player locations
- ❤️ **Stats** — HP, Prayer, Energy, and world indicators with inactivity detection
- 📜 **Quest Progress** — Completed, finished, and in-progress quests

## ✨ Features

- **Device Pairing** — Simple 5-digit pairing codes to link RuneLite clients to your group
- **Auto-add Members** — New players automatically appear on first data submission
- **Secure Token Auth** — Paired devices use hashed tokens for secure communication
- **Generic JSON Ingestion** — Works with standard RuneLite plugin payloads (not limited to Group Ironman)
- **Interactive Dashboard** — Real-time web interface to view group activity

## 🎮 Companion Plugin

You'll need the [RuneLite HomeAssistant Data Exporter](https://github.com/xXD4rkDragonXx/runelite-homeassistant-data-exporter) plugin to send data to this tracker.

## 🚀 Setup

### Option 1: Docker (Recommended)

**Prerequisites:**
- Docker & Docker Compose

**Steps:**

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/ha-osrs-map.git
   cd ha-osrs-map
   ```

2. Create environment file:
   ```bash
   cp .env.example .env
   # Edit .env if needed (defaults work for local development)
   ```

3. Start the full stack:
   ```bash
   docker-compose -f docker-compose-local.yml up -d
   ```

4. Access the application:
   - **Website**: http://localhost:4000
   - **API**: http://localhost:5000

4. Create your group:
   - Go to the website and create a new group
   - You'll receive a group token and pairing code
   - Use the pairing code in your RuneLite plugin

### Option 2: Manual Setup (Development)

**Prerequisites:**
- Rust 1.70+ (for backend)
- Node.js 18+ (for frontend)
- PostgreSQL 14+

**Backend Setup:**

1. Install Rust:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. Set up PostgreSQL:
   ```bash
   # On Windows with PostgreSQL installed
   createdb osrs_tracker
   
   # Or use Docker for just the database:
   docker run -d \
     -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=osrs_tracker \
     -p 5432:5432 \
     postgres:14
   ```

3. Configure the backend:
   ```bash
   cd server
   
   # Copy and edit the config file
   cp config.toml.example config.toml
   # Edit config.toml with your database credentials
   
   # Create a secret file for token hashing (use a random string)
   # On Linux/Mac:
   echo "your-super-secret-random-string-here" > secret
   
   # On Windows (PowerShell):
   # "your-super-secret-random-string-here" | Out-File -FilePath secret -NoNewline
   
   # Run the server
   cargo run --release
   ```

   The API will be available at `http://localhost:8000`

   **Note**: The `secret` file should contain a random string used for cryptographic hashing. Keep it secure and never commit it to version control.

**Frontend Setup:**

1. Install dependencies:
   ```bash
   cd site
   npm install
   ```

2. Start the development server:
   ```bash
   npm run start:local-api
   ```

   The website will be available at `http://localhost:4000`

## 🔄 Usage Flow

1. **Create a group** via the website (pick a group name, get a group token)
2. **Generate a pairing code**: `POST /api/group/{group_name}/pair/code` (requires group token in `Authorization` header)
3. **Install the RuneLite plugin** and pair using your 5-digit code
4. **Pair a device**: `POST /api/osrs-data/pair` with `{ "code": "12345" }` — returns a device token
5. **Start tracking**: Plugin automatically sends data using the device token
6. Players are auto-added to the group on first successful data submission

## 🏗️ Project Structure

```
├── server/          # Rust backend (Actix-web + PostgreSQL)
├── site/            # TypeScript/JavaScript frontend (Webpack)
├── cache/           # Data processing utilities
├── backup/          # Backup scripts
└── docker-compose*.yml  # Docker orchestration
```

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome! Feel free to open issues and pull requests.

## 🙏 Credits

- Built for the OSRS community
- The source code of this frontend/backend by [christoabrown](https://github.com/christoabrown/group-ironmen)
- RuneLite companion plugin by [xXD4rkDragonXx](https://github.com/xXD4rkDragonXx)

