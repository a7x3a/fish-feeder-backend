# 🧠 Backend API Logic - Complete Explanation

This document explains how the FishFeeder backend works, what it does, and how all components interact.

## 📋 Overview

The backend is a **Next.js API** that manages the entire fish feeding system. It handles:
- Feed scheduling and execution
- Reservation queue management
- Auto feed automation
- Device status monitoring
- Sensor alerts (TDS, Temperature)
- Telegram notifications and bot commands

**Important:** The Arduino (ESP8266) ONLY handles:
- Servo control (opens/closes when `status = 1`)
- Sensor readings (TDS, Temperature)
- Device status updates (WiFi, uptime, lastSeen)

**The backend handles EVERYTHING else:**
- All feed scheduling
- All reservation management
- All notifications
- All logic and decision-making

---

## 🏗️ System Architecture

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

### Data Flow

1. **Frontend** → Calls backend API → Backend updates Firebase
2. **Backend** → Reads from Firebase → Makes decisions → Updates Firebase
3. **Arduino** → Reads `status = 1` from Firebase → Opens servo → Resets `status = 0`
4. **Backend** → Sends Telegram notifications
5. **Telegram** → User sends commands → Backend responds

---

## 🔄 Core Components

### 1. **Cron System** (`/api/cron/execute`)

**Purpose:** Main automated scheduler that runs every 5 minutes via FastCron.

**Flow:**
```
1. Authenticate request (CRON_SECRET)
2. Load feeder data from Firebase
3. Check fasting day → Skip if fasting
4. Check device online → Skip if offline
5. Check status → Skip if already feeding
6. Check cooldown → Skip if cooldown active
7. Check reservations → Execute if ready
8. Check auto feed → Execute if conditions met
9. Return response
```

**Key Features:**
- Fast response times (< 5 seconds)
- Non-blocking device reads
- Graceful degradation
- Timeout protection (5-7 seconds)

**Response Types:**
- `{"type":"reservation","user":"John"}` - Reservation executed
- `{"type":"timer","user":"System"}` - Auto feed executed
- `{"type":"none","reason":"no_feed_needed"}` - Nothing to do
- `{"type":"none","reason":"device_offline"}` - Device offline
- `{"type":"none","reason":"fasting_day"}` - Fasting day
- `{"type":"none","reason":"cooldown_active"}` - Cooldown active

---

### 2. **Manual Feed** (`/api/feed/manual`)

**Purpose:** Execute immediate feed when user clicks "Feed Now" button.

**Flow:**
```
1. Validate request (user, userEmail, deviceId)
2. Check fasting day → Error if fasting
3. Check device online → Error if offline
4. Check cooldown → Error if cooldown active
5. Check reservations → Error if reservations exist
6. Check status → Error if already feeding
7. Update lastFeedTime and lastFeed
8. Set status = 1 (triggers Arduino servo)
9. Send Telegram notification
10. Return success
```

**Key Rules:**
- Only works when cooldown finished
- Only works when no reservations exist
- Updates `lastFeedTime` BEFORE setting `status = 1`
- Sends Telegram notification

---

### 3. **Reservation System**

#### Create Reservation (`/api/reservations/create`)

**Purpose:** Add user to feed queue for scheduled feeding.

**Flow:**
```
1. Validate request
2. Check fasting day → Error if fasting
3. Check if user already has reservation → Return existing
4. Check queue limit (max 20) → Error if full
5. Calculate scheduledTime:
   - If reservations exist: lastReservation.scheduledTime + cooldownMs
   - Else: max(now, lastFeedTime + cooldownMs)
6. Add to reservations array
7. Send Telegram notification
8. Return reservation details
```

**Key Features:**
- FIFO queue (First In, First Out)
- Automatic time calculation
- Queue limit (20 reservations)
- Duplicate detection

#### Cancel Reservation (`/api/reservations/cancel`)

**Purpose:** Remove user from feed queue.

**Flow:**
```
1. Find reservation by deviceId or userEmail
2. Remove from array
3. Recalculate remaining reservations' scheduledTimes
4. Send Telegram notification
5. Return success
```

---

### 4. **Feed Priority System**

The system follows a strict priority order:

#### **Priority 1: Manual Feed**
- Triggered by frontend
- Executes immediately (if cooldown finished, no reservations)
- Highest priority

#### **Priority 2: Reservation Feed**
- Scheduled feeds from queue
- Executes when `scheduledTime <= now`
- FIFO order (oldest first)

#### **Priority 3: Auto Feed**
- Automatic feed after cooldown + delay
- Only if no reservations exist
- Lowest priority

**Rules:**
- Manual feed blocks everything
- Reservations block auto feed
- Auto feed only runs if no reservations

---

### 5. **Feed Execution** (`triggerFeed`)

**Purpose:** Execute a feed by updating Firebase and triggering Arduino.

**Flow:**
```
1. Update lastFeedTime (epoch milliseconds)
2. Update lastFeed (timestamp object)
3. Set status = 1 (Arduino detects this and opens servo)
4. Arduino automatically resets status = 0 after 1 second
5. Update history (non-blocking)
6. Send Telegram notification (non-blocking)
```

**Critical Rules:**
- **NEVER** let Arduino update `lastFeedTime` (prevents millis() overflow bug)
- Update `lastFeedTime` BEFORE setting `status = 1`
- Use epoch milliseconds, not Arduino millis()

---

### 6. **Device Status Monitoring**

**Purpose:** Monitor Arduino connection and send alerts.

**Checks:**
- `lastSeen` timestamp (in seconds from Arduino)
- `wifi` status (connected/disconnected)
- `uptime` (device uptime in seconds)

**Online Detection:**
- If `lastSeen` exists and < 60 seconds ago → Online
- If `lastSeen` missing but `uptime > 0` and `wifi = connected` → Online
- Otherwise → Offline

**Alerts:**
- Device goes offline → Telegram notification
- Device comes online → Telegram notification
- Throttled (once per 15 minutes)

---

### 7. **Sensor Alerts**

**Purpose:** Monitor water quality and temperature.

**TDS Alert:**
- Trigger: TDS > 800 ppm
- Throttle: Once per 30 minutes
- Message: Water quality warning with recommendations

**Temperature Alert:**
- Trigger: Temperature < 20°C or > 30°C
- Throttle: Once per 30 minutes
- Message: Temperature warning with recommendations

---

### 8. **Telegram Bot**

**Purpose:** Interactive bot for system monitoring and control.

#### Webhook Endpoint (`/api/telegram/webhook`)

**Flow:**
```
1. Receive POST request from Telegram
2. Parse message text and chat ID
3. Verify chat ID matches TELEGRAM_CHAT_ID
4. Process command
5. Send response
```

#### Commands

- `/status` - Full system status
- `/nextfeed` - Next feed timing
- `/cooldown` - Cooldown status
- `/reservations` - Active reservations
- `/history` - Feed history
- `/help` - Command list
- `/clear` - Clear messages

#### Notifications

Automatically sent for:
- Manual feeds
- Reservation feeds
- Auto feeds
- Device status changes
- Sensor alerts

---

## 🔑 Critical Rules

### Rule 1: Never Update lastFeedTime from Arduino
- Arduino does NOT update `lastFeedTime`
- Only backend and frontend update it
- Prevents Arduino `millis()` overflow bug

### Rule 2: Update Times BEFORE Setting Status
```javascript
// CORRECT ORDER:
await feederRef.child('lastFeedTime').set(timestampMs);
await feederRef.child('lastFeed').set({ timestamp, hour, minute, second });
await feederRef.child('status').set(1); // Arduino sees this and opens servo
```

### Rule 3: Check Status Before Feeding
- Prevent duplicate feeds
- Check `status === 1` before executing
- Return error if already feeding

### Rule 4: Device Online Check
- Arduino stores `lastSeen` in SECONDS (not milliseconds)
- Check if `lastSeen < 60 seconds` ago
- Fallback: Check `uptime` and `wifi` status

### Rule 5: Validate lastFeedTime
- Reject invalid values (< year 2000)
- Arduino `millis()` can overflow and create invalid timestamps
- Use current time if invalid

---

## 📊 Database Structure

### Firebase Realtime Database

```
system/
  feeder/
    status: 0 | 1                    # 0 = idle, 1 = feeding
    lastFeedTime: number              # Epoch milliseconds
    lastFeed: {                       # Last feed details
      timestamp: number
      hour: number
      minute: number
      second: number
    }
    timer: {                          # Feed interval
      hour: number                    # Hours
      minute: number                  # Minutes
      noFeedDay: number | null         # 0-6 (Sunday-Saturday) or null
    }
    priority: {                       # Delay settings
      reservationDelayMinutes: number
      autoFeedDelayMinutes: number
    }
    reservations: [                   # Reservation queue
      {
        user: string
        userEmail: string
        deviceId: string
        scheduledTime: number          # Epoch milliseconds
        createdAt: number              # Epoch milliseconds
      }
    ]
    history: [                        # Feed history (last 20)
      {
        timestamp: number
        type: "manual" | "reservation" | "timer"
        user: string
      }
    ]
  
  device/
    lastSeen: number                  # Epoch seconds (from Arduino)
    wifi: "connected" | "disconnected"
    uptime: number                    # Seconds
    servo: "on" | "off"
  
  sensors/
    tds: number                       # TDS in ppm
    temperature: number               # Temperature in °C
  
  alerts/
    lastOfflineAlert: number          # Epoch milliseconds
    lastOnlineAlert: number
    lastTdsAlert: number
    lastTempAlert: number
  
  telegram/
    messageIds: [number]              # Telegram message IDs
    count: number                     # Message count
```

---

## 🔄 Complete Flow Examples

### Example 1: Manual Feed

```
User clicks "Feed Now" button
    ↓
Frontend calls POST /api/feed/manual
    ↓
Backend checks:
  - Fasting day? → No
  - Device online? → Yes
  - Cooldown finished? → Yes
  - Reservations exist? → No
  - Already feeding? → No
    ↓
Backend updates:
  - lastFeedTime = now
  - lastFeed = { timestamp, hour, minute, second }
  - status = 1
    ↓
Arduino detects status = 1
    ↓
Arduino opens servo for 1 second
    ↓
Arduino resets status = 0
    ↓
Backend sends Telegram: "✅ Manual Feed"
    ↓
Backend returns success
```

### Example 2: Reservation Feed (via Cron)

```
FastCron calls GET /api/cron/execute every 5 minutes
    ↓
Backend checks:
  - Fasting day? → No
  - Device online? → Yes
  - Cooldown finished? → Yes
  - Reservations ready? → Yes (scheduledTime <= now)
    ↓
Backend executes first ready reservation:
  - Updates lastFeedTime
  - Updates lastFeed
  - Sets status = 1
  - Removes reservation from queue
  - Recalculates remaining reservations
    ↓
Arduino detects status = 1 and opens servo
    ↓
Backend sends Telegram: "🎉 Reservation Feed"
    ↓
Backend returns: {"type":"reservation","user":"John"}
```

### Example 3: Auto Feed (via Cron)

```
FastCron calls GET /api/cron/execute
    ↓
Backend checks:
  - Fasting day? → No
  - Device online? → Yes
  - Cooldown finished? → Yes
  - Reservations exist? → No
  - Auto feed delay passed? → Yes
    ↓
Backend executes auto feed:
  - Updates lastFeedTime
  - Updates lastFeed
  - Sets status = 1
    ↓
Arduino detects status = 1 and opens servo
    ↓
Backend sends Telegram: "🤖 Auto Feed"
    ↓
Backend returns: {"type":"timer","user":"System"}
```

---

## ⚡ Performance Optimizations

### Timeout Protection
- All Firebase operations have timeouts (5-8 seconds)
- Prevents hanging operations
- Fast failure on timeouts

### Non-Blocking Operations
- Telegram notifications: Non-blocking
- History updates: Non-blocking
- Reservation updates: Non-blocking (where appropriate)

### Parallel Operations
- `lastFeed` and `status` updates: Parallel
- Device reads: Non-blocking (optional)

### Graceful Degradation
- Device read fails: Assume online, continue
- Telegram fails: Log error, don't break feed
- History update fails: Log error, don't break feed

---

## 🛡️ Error Handling

### Input Validation
- All inputs validated and sanitized
- String length limits
- Type checking
- Array structure validation

### Error Responses
- Proper HTTP status codes
- Clear error messages
- Consistent error format

### Timeout Handling
- Firebase timeout: Returns `{"error":"firebase_timeout"}`
- Telegram timeout: Retries with backoff
- Fast failure on timeouts

---

## 📱 Telegram Integration

### Message Formatting
- HTML formatting (`<b>`, `<code>`)
- Emojis for visual appeal
- Structured sections
- Clear labels and values

### Command Processing
- Webhook receives POST from Telegram
- Parses message text
- Validates chat ID
- Executes command
- Sends formatted response

### Notification System
- Automatic notifications for all events
- Retry logic for reliability
- Timeout protection
- Message limit management (10 messages max)

---

## 🔐 Security

### Authentication
- CRON_SECRET for cron endpoints
- Telegram chat ID validation
- Environment variables for secrets

### Data Validation
- Input sanitization
- Type checking
- Length limits
- Array validation

### Error Handling
- Never expose sensitive data
- Clear error messages
- Proper HTTP status codes

---

## 📊 Key Metrics

### Response Times
- Normal case: < 2 seconds
- With feed: < 5 seconds
- Timeout case: < 5 seconds (returns error)

### Reliability
- Timeout protection on all operations
- Graceful degradation
- Non-blocking operations
- Retry logic for Telegram

---

## ✅ Summary

The backend is a **complete automation system** that:
- ✅ Manages all feed scheduling
- ✅ Handles reservation queue
- ✅ Executes auto feeds
- ✅ Monitors device status
- ✅ Sends sensor alerts
- ✅ Provides Telegram bot interface
- ✅ Ensures reliable operation
- ✅ Handles all edge cases

**Everything is automated - the system runs itself!** 🎉

