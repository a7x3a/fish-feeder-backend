# Fish Feeder Backend API - Implementation Guide

## Overview

This document provides complete specifications for implementing a Next.js API backend that manages the Fish Feeder system. The backend handles reservations, auto-feeds via cron jobs, and sends Telegram notifications.

**Important**: The Arduino ONLY handles servo control and sensor readings. ALL scheduling, reservations, and notifications are handled by this backend.

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Frontend     │────▶│   Next.js API   │────▶│    Firebase     │
│   (React App)   │     │    (Backend)    │     │  Realtime DB    │
└─────────────────┘     └────────┬────────┘     └────────┬────────┘
                                 │                       │
                                 ▼                       ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │ Telegram Bot    │     │   ESP8266       │
                        │ (Notifications) │     │   (Arduino)     │
                        └─────────────────┘     └─────────────────┘
```

---

## Firebase Database Structure

```json
{
  "system": {
    "feeder": {
      "status": 0,
      "lastFeed": {
        "timestamp": 1705315800000,
        "hour": 10,
        "minute": 30,
        "second": 0
      },
      "lastFeedTime": 1705315800000,
      "timer": {
        "hour": 3,
        "minute": 0,
        "noFeedDay": null
      },
      "priority": {
        "reservationDelayMinutes": 0,
        "autoFeedDelayMinutes": 30
      },
      "reservations": [],
      "history": []
    },
    "device": {
      "wifi": "connected",
      "uptime": 3600,
      "servo": "off",
      "lastSeen": 1705315800000
    },
    "sensors": {
      "tds": 350.5,
      "temperature": 24.5
    }
  }
}
```

---

## Environment Variables

Create `.env.local` in the Next.js project:

```env
# Firebase Admin SDK
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-client-email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-project.firebaseio.com

# Telegram Bot
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# Cron Secret (for securing cron endpoints)
CRON_SECRET=your-random-secret-key
```

---

## API Endpoints

### 1. Manual Feed

**Endpoint**: `POST /api/feed/manual`

**Purpose**: Execute an immediate manual feed (only if cooldown finished and no reservations)

**Request Body**:
```json
{
  "user": "john_doe",
  "userEmail": "john@example.com",
  "deviceId": "abc123-def456"
}
```

**Logic**:
1. Check if today is fasting day → reject if true
2. Check if cooldown finished (current time >= lastFeedTime + cooldownMs)
3. Check if reservations exist → reject if any exist (reservations have priority)
4. If can feed:
   - Set `status = 1` in Firebase (Arduino will open servo)
   - Update `lastFeed` with timestamp, hour, minute, second
   - Update `lastFeedTime` with epoch milliseconds
   - Add to history with type "manual"
   - Send Telegram notification
5. Return success/error response

**Response**:
```json
{
  "success": true,
  "message": "Feed executed successfully",
  "feedTime": 1705315800000,
  "type": "manual",
  "user": "john_doe"
}
```

**Error Response**:
```json
{
  "success": false,
  "error": "COOLDOWN_ACTIVE",
  "message": "Cooldown active. Time remaining: 30 minutes",
  "cooldownEndsAt": 1705317600000
}
```

---

### 2. Create Reservation

**Endpoint**: `POST /api/reservations/create`

**Purpose**: Add user to reservation queue

**Request Body**:
```json
{
  "user": "john_doe",
  "userEmail": "john@example.com",
  "deviceId": "abc123-def456"
}
```

**Logic**:
1. Check if today is fasting day → reject if true
2. Check if user/device already has reservation → return existing if found
3. Check if reservation limit reached (max 20) → reject if full
4. Calculate scheduled time:
   - If reservations exist: last reservation's scheduledTime + cooldownMs
   - Else: max(now, lastFeedTime + cooldownMs)
5. Create reservation object and add to queue
6. Send Telegram notification
7. Return reservation details

**Response**:
```json
{
  "success": true,
  "reservation": {
    "user": "john_doe",
    "userEmail": "john@example.com",
    "deviceId": "abc123-def456",
    "scheduledTime": 1705319400000,
    "createdAt": 1705315800000,
    "position": 3
  }
}
```

---

### 3. Cancel Reservation

**Endpoint**: `DELETE /api/reservations/cancel`

**Purpose**: Remove user's reservation from queue

**Request Body**:
```json
{
  "deviceId": "abc123-def456",
  "userEmail": "john@example.com"
}
```

**Logic**:
1. Find reservation by deviceId or userEmail
2. Remove from queue
3. Recalculate remaining reservations' scheduledTime
4. Send Telegram notification
5. Return success

---

### 4. Execute Reservations (CRON)

**Endpoint**: `POST /api/cron/execute-reservations`

**Purpose**: Check and execute ready reservations (run every 30 seconds)

**Headers**:
```
Authorization: Bearer YOUR_CRON_SECRET
```

**Logic**:
1. Check if today is fasting day → skip if true
2. Check if device is online (lastSeen within 2 minutes)
3. Get current epoch time
4. Check if cooldown finished (now >= lastFeedTime + cooldownMs)
5. If cooldown finished:
   - Get reservations where scheduledTime <= now
   - Sort by createdAt (FIFO - oldest first)
   - Execute first ready reservation:
     - Set `status = 1` in Firebase
     - Update `lastFeed` and `lastFeedTime`
     - Remove reservation from queue
     - Add to history with type "reservation"
     - Send Telegram notification
6. Recalculate remaining reservations' scheduledTimes

**Response**:
```json
{
  "success": true,
  "executed": true,
  "reservation": {
    "user": "john_doe",
    "feedTime": 1705319400000
  }
}
```

---

### 5. Execute Auto Feed (CRON)

**Endpoint**: `POST /api/cron/auto-feed`

**Purpose**: Execute auto feed if no activity after delay (run every minute)

**Headers**:
```
Authorization: Bearer YOUR_CRON_SECRET
```

**Logic**:
1. Check if today is fasting day → skip if true
2. Check if device is online
3. Check if cooldown finished
4. Check if reservations exist → skip if any exist
5. Check if auto feed delay passed (now >= lastFeedTime + cooldownMs + autoFeedDelayMs)
6. If all conditions met:
   - Set `status = 1` in Firebase
   - Update `lastFeed` and `lastFeedTime`
   - Add to history with type "timer"
   - Send Telegram notification

---

### 6. Update Timer Settings

**Endpoint**: `PUT /api/settings/timer`

**Purpose**: Update feed interval (cooldown period)

**Request Body**:
```json
{
  "hour": 3,
  "minute": 0,
  "noFeedDay": 5
}
```

**Logic**:
1. Validate hour (0-23) and minute (0-59)
2. Validate noFeedDay (0-6 or null)
3. Update Firebase
4. Recalculate all reservation scheduledTimes with new cooldown
5. Send Telegram notification if changed

---

### 7. Update Priority Settings

**Endpoint**: `PUT /api/settings/priority`

**Purpose**: Update delay settings

**Request Body**:
```json
{
  "reservationDelayMinutes": 0,
  "autoFeedDelayMinutes": 30
}
```

---

### 8. Get System Status

**Endpoint**: `GET /api/status`

**Purpose**: Get current system status for frontend

**Response**:
```json
{
  "status": 0,
  "lastFeed": {
    "timestamp": 1705315800000,
    "hour": 10,
    "minute": 30,
    "second": 0
  },
  "timer": {
    "hour": 3,
    "minute": 0,
    "noFeedDay": null
  },
  "device": {
    "wifi": "connected",
    "online": true,
    "uptime": 3600
  },
  "sensors": {
    "tds": 350.5,
    "temperature": 24.5
  },
  "reservations": [],
  "canFeed": true,
  "cooldownEndsAt": 1705319400000,
  "autoFeedAt": 1705321200000
}
```

---

## Telegram Notifications

### Bot Setup
1. Create bot via @BotFather on Telegram
2. Get bot token
3. Create a channel/group and add bot as admin
4. Get chat ID

### Notification Messages

**Feed Executed**:
```
🐟 FISH FEEDER ALERT

✅ Feed Executed!
👤 User: john_doe
📋 Type: Manual
🕐 Time: 10:30:00
📅 Date: 2024-01-15

🐠 Your fish are happy!
```

**Reservation Created**:
```
🐟 FISH FEEDER ALERT

📝 New Reservation
👤 User: john_doe
🕐 Scheduled: 13:30:00
📊 Queue Position: 3

⏳ Waiting for feed time...
```

**Reservation Executed**:
```
🐟 FISH FEEDER ALERT

✅ Reservation Completed!
👤 User: john_doe
🕐 Time: 13:30:00

🎉 Reservation executed successfully!
```

**Auto Feed**:
```
🐟 FISH FEEDER ALERT

🤖 Auto Feed Executed
🕐 Time: 16:30:00
📋 Type: System Timer

🐠 No reservations - auto feed triggered.
```

**Device Offline**:
```
🐟 FISH FEEDER ALERT

⚠️ Device Offline!
🕐 Last seen: 10:30:00
📅 Date: 2024-01-15

🔌 Check device connection.
```

**Fasting Day**:
```
🐟 FISH FEEDER ALERT

🚫 Fasting Day Active
📅 Today is Friday
❌ All feeds skipped

🐟 Fish are fasting today.
```

---

## Cron Jobs Configuration

### For Vercel

Add to `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/execute-reservations",
      "schedule": "*/30 * * * * *"
    },
    {
      "path": "/api/cron/auto-feed",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/check-device",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

### For Other Platforms

Use external cron service (cron-job.org, easycron.com) to call endpoints every 30 seconds.

---

## Priority System

```
Priority 1: MANUAL FEED (Highest)
├── Only when cooldown finished AND no reservations
├── User clicks "Feed Now" button
└── Executes immediately

Priority 2: RESERVATION
├── Cooldown finished, execute reservation queue
├── FIFO order (first come, first served)
├── Delay: 0 minutes (configurable)
└── Backend executes via cron

Priority 3: AUTO FEED (Lowest)
├── Only if no reservations AND no manual feed
├── After cooldown + 30 minutes (configurable)
└── Backend executes via cron
```

---

## Important Implementation Notes

### 1. Time Handling
- ALL times must be in **epoch milliseconds** (not seconds!)
- Use `Date.now()` in JavaScript
- Store timezone-aware times for display (hour, minute, second)

### 2. Cooldown Calculation
```javascript
const cooldownMs = (timer.hour * 3600000) + (timer.minute * 60000);
const cooldownEndsAt = lastFeedTime + cooldownMs;
const canFeed = Date.now() >= cooldownEndsAt;
```

### 3. Reservation Scheduling
```javascript
function calculateScheduledTime(reservations, lastFeedTime, cooldownMs) {
  const now = Date.now();
  
  if (reservations.length > 0) {
    // Schedule after last reservation
    const lastReservation = reservations[reservations.length - 1];
    return lastReservation.scheduledTime + cooldownMs;
  }
  
  // Schedule after cooldown
  const cooldownEnds = lastFeedTime + cooldownMs;
  return Math.max(now, cooldownEnds);
}
```

### 4. Fasting Day Check
```javascript
function isFastingDay(noFeedDay) {
  if (noFeedDay === null || noFeedDay < 0 || noFeedDay > 6) {
    return false;
  }
  const today = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return today === noFeedDay;
}
```

### 5. Device Online Check
```javascript
function isDeviceOnline(lastSeen) {
  const TWO_MINUTES = 2 * 60 * 1000;
  return Date.now() - lastSeen < TWO_MINUTES;
}
```

---

## File Structure

```
/app
  /api
    /feed
      /manual
        route.ts          # POST - Execute manual feed
    /reservations
      /create
        route.ts          # POST - Create reservation
      /cancel
        route.ts          # DELETE - Cancel reservation
    /cron
      /execute-reservations
        route.ts          # POST - Cron: execute reservations
      /auto-feed
        route.ts          # POST - Cron: auto feed
      /check-device
        route.ts          # POST - Cron: check device status
    /settings
      /timer
        route.ts          # PUT - Update timer
      /priority
        route.ts          # PUT - Update priority settings
    /status
      route.ts            # GET - Get system status
/lib
  firebase-admin.ts       # Firebase Admin SDK initialization
  telegram.ts             # Telegram bot functions
  utils.ts                # Helper functions
```

---

## Firebase Admin SDK Setup

```typescript
// lib/firebase-admin.ts
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const firebaseAdminConfig = {
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

export function getFirebaseAdmin() {
  if (getApps().length === 0) {
    initializeApp(firebaseAdminConfig);
  }
  return getDatabase();
}
```

---

## Telegram Bot Setup

```typescript
// lib/telegram.ts
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Not configured, skipping notification');
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
        }),
      }
    );

    if (!response.ok) {
      console.error('[Telegram] Failed to send message');
    }
  } catch (error) {
    console.error('[Telegram] Error:', error);
  }
}

export function formatFeedNotification(type: string, user: string, time: Date) {
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });
  const dateStr = time.toLocaleDateString('en-US');
  
  return `🐟 <b>FISH FEEDER ALERT</b>

✅ Feed Executed!
👤 User: ${user}
📋 Type: ${type}
🕐 Time: ${timeStr}
📅 Date: ${dateStr}

🐠 Your fish are happy!`;
}
```

---

## Testing

### Test Manual Feed
```bash
curl -X POST http://localhost:3000/api/feed/manual \
  -H "Content-Type: application/json" \
  -d '{"user":"test_user","deviceId":"test-device"}'
```

### Test Create Reservation
```bash
curl -X POST http://localhost:3000/api/reservations/create \
  -H "Content-Type: application/json" \
  -d '{"user":"test_user","deviceId":"test-device"}'
```

### Test Cron Endpoint
```bash
curl -X POST http://localhost:3000/api/cron/execute-reservations \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `COOLDOWN_ACTIVE` | Feed cooldown not finished |
| `RESERVATIONS_EXIST` | Cannot manual feed when reservations in queue |
| `FASTING_DAY` | Today is configured fasting day |
| `DEVICE_OFFLINE` | Arduino not responding |
| `ALREADY_HAS_RESERVATION` | User/device already has reservation |
| `QUEUE_FULL` | Maximum 20 reservations reached |
| `UNAUTHORIZED` | Invalid cron secret |

---

## Summary

1. **Arduino** only responds to `status = 1` and updates sensors
2. **Backend** manages ALL scheduling via cron jobs
3. **Frontend** calls API endpoints instead of direct Firebase
4. **Telegram** receives notifications for all events
5. **Priority**: Manual > Reservation > Auto

This creates a robust, scalable system where the ESP8266 Arduino only handles hardware, and all intelligence is in the Next.js backend.

