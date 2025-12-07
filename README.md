# FishFeeder Backend API 🐟

Next.js API backend for the FishFeeder IoT system. Handles automated feed scheduling, reservations, and Telegram notifications.

## 📋 Overview

This is a **standalone backend project** that provides API routes for:
- Automated feed scheduling (cron jobs via FastCron)
- Manual feed execution
- Reservation queue management
- Auto feed management
- Firebase Realtime Database integration
- Telegram bot notifications and commands

The frontend (React + Vite) is in a separate repository.

## 🏗️ Architecture

- **Framework:** Next.js 14 (API routes only, no pages)
- **Database:** Firebase Realtime Database (via Firebase Admin SDK)
- **Deployment:** Vercel (serverless functions)
- **Cron Service:** FastCron (external service)
- **Language:** JavaScript (ES Modules)

## 📦 Installation

```bash
# Install dependencies
npm install

# Create .env.local file (see Environment Setup below)
```

## ⚙️ Environment Setup

Create a `.env.local` file in the `fishfeeder-backend/` root directory:

```env
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"fishfeeder-81131",...}
FIREBASE_DB_URL=https://fishfeeder-81131-default-rtdb.firebaseio.com/
CRON_SECRET=your-random-secret-key-here
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=your-telegram-chat-id
```

### Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Project: **fishfeeder-81131**
3. ⚙️ Settings → Project settings → Service accounts
4. Click "Generate new private key"
5. Download JSON file
6. **Minify the JSON** to a single line using: https://www.freeformatter.com/json-minifier.html
7. Add minified JSON to `FIREBASE_SERVICE_ACCOUNT` in `.env.local`

### Get Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` command
3. Follow instructions to create your bot
4. Copy the bot token
5. Add to `TELEGRAM_BOT_TOKEN` in `.env.local`

### Get Telegram Chat ID

1. Open Telegram and search for [@userinfobot](https://t.me/userinfobot)
2. Start a conversation
3. The bot will send your chat ID
4. Add to `TELEGRAM_CHAT_ID` in `.env.local`

## 🚀 Development

```bash
# Start development server
npm run dev

# Server runs on http://localhost:3000
```

## 📦 Build

```bash
# Build for production
npm run build

# Start production server
npm start
```

## 🌐 Deployment

1. Push code to GitHub
2. Import project in [Vercel Dashboard](https://vercel.com/dashboard)
3. Add environment variables in Vercel Settings
4. Deploy!

## 🔄 API Endpoints

### Main Endpoints

- **`GET/POST /api/cron/execute`** - Main cron endpoint (FastCron compatible)
- **`POST /api/feed/manual`** - Manual feed execution
- **`POST /api/reservations/create`** - Create reservation
- **`DELETE /api/reservations/cancel`** - Cancel reservation
- **`GET /api/status`** - System status
- **`PUT /api/settings/timer`** - Update timer settings
- **`PUT /api/settings/priority`** - Update priority settings
- **`POST /api/telegram/webhook`** - Telegram bot webhook

For complete backend logic explanation, see **[API_LOGIC.md](./API_LOGIC.md)**.

## ⏰ Cron Setup

This backend uses **FastCron** (external service) to call the cron endpoint every 5 minutes.

**Endpoint:** `GET/POST https://your-backend.vercel.app/api/cron/execute`
**Schedule:** Every 5 minutes (`*/5 * * * *`)
**Authentication:** `Authorization: Bearer YOUR_CRON_SECRET`

### FastCron Configuration

1. Go to [FastCron.com](https://fastcron.com) or [Cron-Job.org](https://cron-job.org)
2. Create account and add new cron job
3. **URL:** `https://your-backend.vercel.app/api/cron/execute`
4. **Method:** `GET` or `POST`
5. **Schedule:** `*/5 * * * *` (every 5 minutes)
6. **Headers:**
   ```
   Authorization: Bearer YOUR_CRON_SECRET
   ```
7. **Body:** Leave empty

## 🤖 Telegram Bot Commands

The backend includes a Telegram bot that responds to commands and sends notifications.

### Setup Webhook

Set your Telegram bot webhook to:
```
https://your-backend.vercel.app/api/telegram/webhook
```

You can set it using:
```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \
  -d "url=https://your-backend.vercel.app/api/telegram/webhook"
```

### Available Commands

#### `/status` - System Status
Shows complete system information:
- Device status (online/offline)
- WiFi, Servo, Uptime
- Last feed time
- Next feed time and type
- Time remaining
- Cooldown status
- Sensor readings (Temperature, TDS)
- Reservation count

**Example:**
```
/status
```

**Response:**
```
📊 SYSTEM STATUS

🔌 Device Status:
   🟢 Status: ONLINE
   📶 WiFi: connected
   ⚙️ Servo: off
   ⏱️ Uptime: 2h 15m

🍽️ Feed Status:
   🕐 Last Feed: Jan 15, 2:30 PM
   ⏰ Next Feed: Jan 15, 3:00 PM
   🔧 Type: Reservation (John)
   ⏳ Time Remaining: 25m
   ⏱️ Cooldown: 0:30

🌡️ Sensors:
   🌡️ Temperature: 25°C
   💧 TDS: 350 ppm

📌 Reservations:
   📋 Count: 2
```

---

#### `/nextfeed` or `/next` - Next Feed Timing
Shows when the next feed will happen:
- Feed type (Reservation or Auto Feed)
- Scheduled time
- Time remaining

**Example:**
```
/nextfeed
```

**Response:**
```
⏰ NEXT FEED

🔧 Type: Reservation (John)
🕐 Scheduled: Jan 15, 3:00 PM
⏳ Time Remaining: 25m

📌 Reservations: 2 in queue
```

---

#### `/cooldown` - Cooldown Status
Shows cooldown information:
- Cooldown period
- Last feed time
- When cooldown ends
- Time remaining

**Example:**
```
/cooldown
```

**Response:**
```
⏳ COOLDOWN STATUS

⏱️ Cooldown Period: 0:30
⏰ Last Feed: Jan 15, 2:30 PM
🕐 Cooldown Ends: Jan 15, 3:00 PM

⏳ Time Remaining: 25m
```

---

#### `/reservations` or `/res` - Active Reservations
Shows all active reservations with time remaining for each:
- Total reservation count
- Each reservation with:
  - User name
  - Scheduled time
  - Time remaining

**Example:**
```
/reservations
```

**Response:**
```
📌 ACTIVE RESERVATIONS

Total: 2 reservation(s)

1. John
   🕐 Jan 15, 3:00 PM
   ⏳ 25m

2. Jane
   🕐 Jan 15, 3:30 PM
   ⏳ 55m
```

---

#### `/history` - Feed History
Shows the last 5 feed events:
- Feed type
- User
- Time

**Example:**
```
/history
```

**Response:**
```
📜 LAST 5 FEEDS

1. [manual] John – Jan 15, 2:30 PM
2. [reservation] Jane – Jan 15, 1:00 PM
3. [timer] System – Jan 15, 12:00 PM
4. [manual] John – Jan 15, 11:00 AM
5. [reservation] Jane – Jan 15, 10:00 AM
```

---

#### `/help` or `/start` - Help Command
Shows all available commands.

**Example:**
```
/help
```

**Response:**
```
🤖 FishFeeder Bot Commands

📊 Information:
  /status – Full system status
  /nextfeed – When next feed will happen
  /cooldown – Cooldown status and time remaining
  /reservations – Active reservation queue with time left
  /history – Last 5 feed events

🔧 Actions:
  /clear – Clear all bot messages
  /help – Show this help message
```

---

#### `/clear` - Clear Messages
Clears all bot messages from the chat.

**Example:**
```
/clear
```

**Response:**
```
✅ Chat Cleared
🗑️ Deleted 5 message(s).
```

---

## 📱 Telegram Notifications

The bot automatically sends notifications for:

### Manual Feed
```
✅ MANUAL FEED

👤 User: John
📅 Date: Jan 15
🕐 Time: 2:30 PM
🔧 Type: Manual
```

### Reservation Feed
```
🎉 RESERVATION FEED EXECUTED

👤 User: John
📅 Date: Jan 15
🕐 Time: 3:00 PM
🔧 Type: Reservation

✨ Scheduled feed completed successfully.
```

### Auto Feed
```
🤖 AUTO FEED EXECUTED

📅 Date: Jan 15
🕐 Time: 3:00 PM
🔧 Type: Auto Feed

✨ System automatically fed the fish.
```

### Device Offline
```
🔴 DEVICE OFFLINE

⚠️ The feeder has lost internet connection.

📡 Connection Info:
   🕐 Last Seen: Jan 15 2:25 PM
   ⏰ Time Since: 5m ago

💡 Check Arduino WiFi connection and power.
```

### Device Online
```
🟢 DEVICE ONLINE

✅ Connection restored successfully.

📡 Connection Info:
   📶 WiFi: connected
   ⏱️ Uptime: 2h 15m
   🕐 Last Sync: Jan 15 2:30 PM

✨ System is operational.
```

### TDS Alert (High)
```
⚠️ WATER QUALITY WARNING

💧 TDS Level: 850 ppm
📊 Normal Range: 200–600 ppm
🔴 Status: HIGH

⏰ Time: Jan 15, 2:30 PM

💡 Consider water change or filtration.
```

### Temperature Alert
```
🔥 TEMPERATURE WARNING

🌡️ Current: 32°C
📊 Safe Range: 20–30°C
🔴 Status: HIGH

⏰ Time: Jan 15, 2:30 PM

💡 Consider cooling or shade.
```

## 📁 Project Structure

```
fishfeeder-backend/
├── app/
│   ├── api/
│   │   ├── cron/
│   │   │   └── execute/route.js    # Main cron handler
│   │   ├── feed/
│   │   │   └── manual/route.js     # Manual feed endpoint
│   │   ├── reservations/
│   │   │   ├── create/route.js     # Create reservation
│   │   │   └── cancel/route.js     # Cancel reservation
│   │   ├── settings/
│   │   │   ├── timer/route.js      # Timer settings
│   │   │   └── priority/route.js   # Priority settings
│   │   ├── status/route.js          # System status
│   │   └── telegram/
│   │       └── webhook/route.js    # Telegram bot webhook
│   └── layout.js                    # Root layout
├── lib/
│   ├── services/
│   │   ├── firebase.js              # Firebase Admin SDK
│   │   └── telegram.js              # Telegram bot service
│   └── utils/
│       ├── alerts.js                # Sensor & device alerts
│       ├── auth.js                  # Authentication utilities
│       ├── cors.js                  # CORS handling
│       └── feeder.js                # Feeder logic utilities
├── next.config.cjs                  # Next.js configuration
├── vercel.json                      # Vercel configuration
├── package.json                     # Dependencies
├── API_LOGIC.md                     # Backend logic explanation
└── README.md                        # This file
```

## 🔐 Security

- Environment variables stored securely in Vercel
- Firebase service account credentials never exposed
- `CRON_SECRET` for endpoint authentication
- Telegram webhook validates chat ID

## 📚 Documentation

- **[API_LOGIC.md](./API_LOGIC.md)** - Complete backend logic and flow explanation

## 🐛 Troubleshooting

### Build Error: "Failed to collect page data"
- Make sure `app/layout.js` exists with `<html>` and `<body>` tags
- Verify `next.config.cjs` is correct
- This is an API-only project (no pages)

### Firebase Initialization Error
- Verify `FIREBASE_SERVICE_ACCOUNT` is valid JSON (single line)
- Check `FIREBASE_DB_URL` is correct
- Ensure environment variables are set in Vercel

### Cron Job Not Running
- Check FastCron configuration
- Verify `CRON_SECRET` is set correctly
- Check endpoint URL is correct

### Telegram Bot Not Working
- Verify `TELEGRAM_BOT_TOKEN` is set
- Verify `TELEGRAM_CHAT_ID` is set
- Check webhook URL is set correctly
- Test with `/help` command

## 📝 License

Private project

---

**For complete backend logic explanation, see [API_LOGIC.md](./API_LOGIC.md)**
