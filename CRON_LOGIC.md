# 🐟 FishFeeder NEXT API – Full Backend Specification  
This document defines the complete backend logic for the FishFeeder system, including:

- Cloud scheduling  
- Feed priority logic  
- Reservations  
- Auto-feed  
- Offline mode handling  
- Device monitoring  
- Telegram messaging  
- Telegram commands (/status, /history, /reservations, /help)  
- Alerts (offline, sensor abnormal, feed executed)  

This is the final master file for backend implementation.

---

# 1. OVERVIEW

Your Next.js API will:

✔️ Handle all feeding logic when device is online  
✔️ Trigger feeds based on priorities  
✔️ Manage reservations (FIFO queue)  
✔️ Execute auto-feed after grace period  
✔️ Detect offline device state  
✔️ Send Telegram alerts & status updates  
✔️ Process Telegram bot commands  
✔️ Periodically run a scheduler (cron job every 1 minute)

ESP8266 handles offline feeding automatically — backend handles everything online.

---

# 2. FIREBASE STRUCTURE

```
system/
  feeder/
    status: 0 | 1
    lastFeedTime: number
    lastFeed: string
    timer:
      hour: number
      minute: number
      noFeedDay: number | null
    delays:
      reservationDelayMinutes: number
      autoFeedDelayMinutes: number
    reservations: [ ... ]
    history: [ ... ]

  device/
    wifi: "connected" | "disconnected"
    uptime: number
    servo: "on" | "off"

  sensors/
    tds: number
    temperature: number

  alerts/
    lastOfflineAlert: timestamp
    lastOnlineAlert: timestamp
    lastTdsAlert: timestamp
    lastTempAlert: timestamp
```

---

# 3. FEED PRIORITY SYSTEM (ONLINE MODE)

Your backend must enforce feed priority:

### **Priority 1 — Manual Feed**
Triggered by frontend:
```
/system/feeder/status = 1
```
Backend must NOT override it.

---

### **Priority 2 — Reservation Feed**
Run when scheduled time is reached:

Flow:
1. Find earliest reservation (`createdAt ASC`)
2. If scheduledTime ≤ now  
3. If cooldown finished  
4. Trigger feed  
5. Remove reservation  
6. Log into history  
7. Send Telegram message  

---

### **Priority 3 — Auto Feed**
Used only when:
- No manual feed  
- No reservation due  
- Cooldown finished  
- Grace period passed  

```
nextFeed = lastFeedTime + interval
graceEnd = nextFeed + autoFeedDelay * 60000
if now >= graceEnd => auto-feed
```

---

# 4. BACKEND SCHEDULER ENDPOINT

Your cron job calls:

```
GET /api/scheduler/run
```

Runs every **1 minute**.

---

## 4.1 Scheduler Steps (MUST FOLLOW ORDER)

### **Step 1 — Load all data**
Fetch:
- lastFeedTime  
- timerHour, timerMinute  
- delays  
- reservations[]  
- wifi status  
- sensor values  

---

### **Step 2 — Handle Device Offline**
If `wifi !== "connected"`:

Do NOT attempt feeding.

But DO:
- Detect offline transitions  
- Send offline alert  
- Track offline duration  
- Clean expired reservations  

Offline logic is done by ESP, not backend.

---

### **Step 3 — Check Reservation Queue (FIFO)**
Find earliest reservation with:
```
scheduledTime <= now
```

If exists:
```
triggerFeed("reservation", user)
```
Send Telegram feed summary.

---

### **Step 4 — Manual Feeds**
If `/status == 1`, backend does nothing.

---

### **Step 5 — Auto Feed**
If cooldown & grace conditions met:
```
triggerFeed("auto", "System")
```
Send Telegram notification.

---

### **Step 6 — Sensor Alerts**
If sensors exceed limits, send Telegram alerts:
- TDS > 800 ppm  
- Temperature < 20°C or > 30°C

Throttle using `/system/alerts/last*` timestamps.

---

### **Step 7 — Update Scheduled Feed Time**
Backend should correct drift and keep scheduled values consistent.

---

# 5. INTERNAL FUNCTION: triggerFeed()

```
async function triggerFeed(type, user) {
  set status = 1

  wait 3–5 seconds

  update:
    lastFeedTime = now
    lastFeed = ISO timestamp

  append history entry:
    { type, user, timestamp }

  sendTelegramFeed(type, user)

  cleanup reservation if needed

  return { ok: true }
}
```

---

# 6. TELEGRAM MESSAGING SYSTEM

Backend must notify Telegram about EVERY important event.

Telegram bot token + chat ID stored in env variables:

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## 6.1 Event: Feed Executed

Send message:

```
🐟 FEED EXECUTED
Type: <manual | reservation | auto | offline>
User: <user>
Time: <local formatted>

Last Feed: <time>
Next Feed: <time>
Cooldown: <hours:minutes>
```

---

## 6.2 Event: Device Offline

Send message if wifi becomes disconnected:

```
❌ DEVICE OFFLINE
The feeder lost internet connection.

Last Feed: <time>
Uptime: <seconds>
```

Throttle: only once every 15 minutes.

---

## 6.3 Event: Device Online

When device reconnects:

```
🟢 DEVICE ONLINE
Connection restored.

Last Sync: <time>
```

---

## 6.4 Sensor Alerts

### High TDS (>800 ppm)
```
⚠️ WATER WARNING
TDS is high: <value> ppm
Normal: 200–600 ppm
```

### Abnormal Temperature (<20 or >30)
```
⚠️ TEMPERATURE WARNING
Current: <temp>°C
Safe Range: 20–30°C
```

Throttle: once per 30 minutes.

---

# 7. TELEGRAM BOT COMMANDS

Your API must handle Telegram webhook:

```
POST /api/telegram/webhook
```

Parse incoming JSON:

```
message.text
message.chat.id
```

Process the following commands:

---

## 7.1 `/status`

Returns:

```
📊 SYSTEM STATUS

Device: <online/offline>
WiFi: <connected/disconnected>
Servo: <on/off>
Uptime: <seconds>

Last Feed: <time>
Next Feed: <time>
Cooldown: <H:M>

Temperature: <value>°C
TDS: <value> ppm

Reservations: <count>
```

---

## 7.2 `/history`

Return last 5 feed entries:

```
📜 LAST 5 FEEDS
1. [manual] Ahmad – 14:30
2. [reservation] visitor – 12:00
3. [offline] System – 10:00
4. [auto] System – 08:00
5. [manual] Ahmad – yesterday
```

---

## 7.3 `/reservations`

```
📌 ACTIVE RESERVATIONS
1. john_doe – 15:45
2. visitor – 16:00
```

If none:
```
No active reservations.
```

---

## 7.4 `/help`

```
FishFeeder Bot Commands:
/status – Show full system status
/history – Last 5 feed events
/reservations – Active reservation queue
/help – Available commands
```

---

# 8. TELEGRAM SERVICE MODULE

Create `services/telegram.js`:

```
export async function sendMessage(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML"
    })
  });
}
```

This function must NEVER block feed logic if Telegram API fails.

---

# 9. SECURITY RULES

- Validate incoming data on all endpoints  
- Prevent manual feed spam  
- Prevent reservation duplicates  
- Prevent feed triggering twice in cooldown window  
- All scheduler actions MUST be idempotent  

---

# 10. ENDPOINT SUMMARY

| Endpoint | Purpose |
|---------|---------|
| GET `/api/scheduler/run` | Main scheduler brain |
| POST `/api/feed/manual` | Trigger manual feed |
| POST `/api/reservations/create` | Add a reservation |
| POST `/api/reservations/cancel` | Cancel reservation |
| GET `/api/device/status` | Device state |
| POST `/api/telegram/webhook` | Bot command handler |
| POST `/api/alerts/telegram` | Send custom alert |

---

# 11. BACKEND GUARANTEES

This system must ensure:

✔️ No double-feeds  
✔️ Reservations always FIFO  
✔️ Offline feeding NEVER breaks online logic  
✔️ Telegram messages are accurate  
✔️ No duplicate alerts  
✔️ Feeds, alerts, scheduler always stable  
✔️ ESP and cloud remain in sync  
✔️ Perfect safety for fish  

---

# END OF DOCUMENT
This is the complete specification for your FishFeeder NEXT API backend.

Your code agent must follow this EXACT document.
