# Backend API - Critical Fixes Required

## Problem Summary

The Arduino was overwriting `lastFeedTime` with invalid values (Arduino `millis()` instead of epoch milliseconds), causing:
1. **Infinite loop** - Frontend auto-fix → Arduino overwrites → Frontend auto-fixes again
2. **Cooldown bypass** - Invalid lastFeedTime breaks cooldown calculation
3. **Device offline** - Status updates were failing

## Solution Applied

### Arduino Changes (Already Done)
- **Arduino NO LONGER updates `lastFeedTime`**
- Arduino only:
  - Opens servo when `status = 1`
  - Closes servo after 1 second
  - Updates sensors (TDS, temperature)
  - Updates device status (wifi, uptime, lastSeen)
- **Frontend/Backend handles all `lastFeedTime` updates**

### Frontend Changes (Already Done)
- Added debounce (3 seconds) to prevent rapid feed clicks
- Auto-fix only runs once per session
- Improved connection detection

## What Backend Must Handle

### 1. Manual Feed Endpoint (`POST /api/feed/manual`)

When processing a manual feed:

```javascript
// CRITICAL: Update lastFeedTime and lastFeed BEFORE setting status = 1
const now = Date.now();
const nowDate = new Date(now);

// 1. Update lastFeedTime (epoch milliseconds)
await db.ref('system/feeder/lastFeedTime').set(now);

// 2. Update lastFeed object
await db.ref('system/feeder/lastFeed').set({
  timestamp: now,
  hour: nowDate.getHours(),
  minute: nowDate.getMinutes(),
  second: nowDate.getSeconds()
});

// 3. THEN trigger the servo
await db.ref('system/feeder/status').set(1);

// Arduino will:
// - Detect status = 1
// - Open servo
// - Close after 1 second
// - Reset status to 0
```

### 2. Cooldown Check

```javascript
function canFeed(lastFeedTime, cooldownMs) {
  if (!lastFeedTime || lastFeedTime === 0) return true;
  
  // Validate lastFeedTime is epoch (not millis from Arduino)
  const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
  if (lastFeedTime < MIN_VALID_EPOCH) {
    console.warn('Invalid lastFeedTime detected:', lastFeedTime);
    return true; // Allow feed if invalid
  }
  
  const now = Date.now();
  return now >= lastFeedTime + cooldownMs;
}
```

### 3. Reservation Execution (Cron Job)

```javascript
async function executeReservation(reservation) {
  const now = Date.now();
  const nowDate = new Date(now);
  
  // 1. Update feed times FIRST
  await db.ref('system/feeder/lastFeedTime').set(now);
  await db.ref('system/feeder/lastFeed').set({
    timestamp: now,
    hour: nowDate.getHours(),
    minute: nowDate.getMinutes(),
    second: nowDate.getSeconds()
  });
  
  // 2. Add to history
  const historyRef = db.ref('system/feeder/history');
  const history = (await historyRef.get()).val() || [];
  history.unshift({
    timestamp: now,
    type: 'reservation',
    user: reservation.user
  });
  await historyRef.set(history.slice(0, 20));
  
  // 3. Remove used reservation
  // ...
  
  // 4. Trigger servo
  await db.ref('system/feeder/status').set(1);
  
  // 5. Send Telegram notification
  // ...
}
```

### 4. Auto Feed (Cron Job)

```javascript
async function autoFeed() {
  const now = Date.now();
  const nowDate = new Date(now);
  
  // Check conditions
  const lastFeedTime = await db.ref('system/feeder/lastFeedTime').get();
  const reservations = await db.ref('system/feeder/reservations').get();
  
  // Don't auto-feed if reservations exist
  if (reservations.val() && reservations.val().length > 0) {
    return;
  }
  
  // Check cooldown + auto-feed delay
  const timer = await db.ref('system/feeder/timer').get();
  const cooldownMs = (timer.val().hour * 3600000) + (timer.val().minute * 60000);
  const autoFeedDelayMs = 30 * 60 * 1000; // 30 minutes
  
  if (now < lastFeedTime.val() + cooldownMs + autoFeedDelayMs) {
    return; // Not time yet
  }
  
  // Execute auto feed
  await db.ref('system/feeder/lastFeedTime').set(now);
  await db.ref('system/feeder/lastFeed').set({
    timestamp: now,
    hour: nowDate.getHours(),
    minute: nowDate.getMinutes(),
    second: nowDate.getSeconds()
  });
  
  // Add to history
  // ...
  
  // Trigger servo
  await db.ref('system/feeder/status').set(1);
  
  // Send Telegram
  // ...
}
```

## Important Notes

1. **Never let Arduino update `lastFeedTime`** - Only backend/frontend should update it
2. **Always validate `lastFeedTime`** - Must be > 946684800000 (year 2000 in ms)
3. **Update times BEFORE triggering servo** - Prevents race conditions
4. **Arduino expects `status = 1`** - Will auto-reset to 0 after feeding

## Telegram Notifications

Send for these events:
- Manual feed executed
- Reservation created
- Reservation executed
- Auto feed executed
- Device went offline

```javascript
async function sendTelegram(message) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });
}
```

## Testing

After implementing, test:
1. Manual feed - should work only when cooldown finished
2. Cooldown - should prevent feeding for the set duration
3. Reservations - should queue and execute in order
4. Auto feed - should trigger after delay if no activity
5. Device status - should show online when Arduino connected

