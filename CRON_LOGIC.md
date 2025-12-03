# 🐟 FishFeeder Cron Backend – Simple Logic Overview

This document explains, in simple language, how the `/api/cron` backend route works and how it controls the fish feeder.

---

## 1. What calls `/api/cron`?

The cron route is **not** called by users directly.  
It is called automatically by:

- **FastCron** (or any external cron service) using:
  - `GET https://your-project.vercel.app/api/cron?secret=CRON_SECRET`
- **Vercel Scheduler** (optional) using:
  - `GET /api/cron` with header `x-vercel-cron: 1`

You can also test it manually in a browser or with curl by calling:

```text
https://your-project.vercel.app/api/cron?secret=CRON_SECRET
```

---

## 2. Security – who is allowed to run cron?

At the very start, the backend checks if the request is allowed:

- It reads `CRON_SECRET` from environment variables.
- In **production**, the request is allowed only if:
  - Header `x-vercel-cron: 1` is present, **or**
  - Header `Authorization: Bearer CRON_SECRET` is present, **or**
  - Query string contains `?secret=CRON_SECRET`
- In **development** (or when `CRON_SECRET` is not set), the check is skipped.

If the check fails, it returns:

```json
{ "error": "Unauthorized" }
```

---

## 3. Connecting to Firebase

If the request is authorized, the backend:

1. Reads the Firebase service account from `FIREBASE_SERVICE_ACCOUNT` (JSON string).
2. Reads the database URL from `FIREBASE_DB_URL`.
3. Initializes the Firebase Admin SDK **only once** (lazy init).
4. Gets access to the Realtime Database.

If this fails, it returns:

```json
{
  "ok": false,
  "error": "Firebase initialization failed"
}
```

---

## 4. Reading current system state

After Firebase is ready, the backend:

1. Sets `now = new Date()` (current time).
2. Reads two paths from the database:
   - `system/feeder` → main feeder settings & state.
   - `system/device` → device connection info (WiFi, uptime).

If `system/feeder` does not exist, it returns:

```json
{ "ok": false, "error": "No feeder data found" }
```

---

## 5. Check if device is online

The device is considered **online** only if:

- `deviceData.wifi === "connected"` **and**
- `deviceData.uptime > 0`

If the device is **offline**:

- A Telegram message is sent:

  ```text
  ⚠️ Device Offline
  ⏰ {now}
  Feed actions skipped.
  ```

- The backend continues, but **will not trigger feeds** when `isDeviceOnline` is false.

---

## 6. Check if device is already feeding

The feeder status is stored at `system/feeder/status`.

- If `status === 1`, the device is already feeding.
- In that case, the backend:
  - Logs a message.
  - Returns:

    ```json
    { "ok": true, "type": "none", "reason": "already_feeding" }
    ```

No new feed is started while one is in progress.

---

## 7. Time settings and fasting day

From `system/feeder`, the backend reads:

- `lastFeedTime` → when the last feed finished.
- `timerHours` and `timerMinutes` → how often auto feed should repeat.
- `delays.autoFeedDelayMinutes` → extra delay after the normal interval.
- `fastingDay` → day of week (0–6) when no feeds should run.

It converts `lastFeedTime` into a JavaScript `Date` and calculates:

- **Cooldown** (interval between feeds):
  - `cooldownMs = timerHours * 3600000 + timerMinutes * 60000`
- **Extra delay**:
  - `autoFeedDelayMs = autoFeedDelayMinutes * 60000`

### Fasting day

If `fastingDay` equals `now.getDay()`:

- Logs that it is a fasting day.
- Sends Telegram:

  ```text
  🕋 Fasting Day
  ⏰ {now}
  No feeds will be executed today.
  ```

- Returns:

  ```json
  { "ok": true, "type": "none", "reason": "fasting_day" }
  ```

No feeds (manual reservations or auto) will be started on a fasting day.

---

## 8. Priority 2 – Reservation feeds

If it is **not** a fasting day and the device is **online**, the backend checks **reservations**:

1. Reads `system/feeder/reservations` (array).
2. Keeps only entries that have a `scheduledTime`.
3. Converts each `scheduledTime` to a `Date`.
4. Selects all reservations where `scheduledTime <= now` (ready to run).
5. Sorts them by `createdAt` (or `scheduledTime`) so the oldest is executed first (FIFO).

If there is at least one **ready** reservation and the device is online:

1. Picks the first reservation.
2. Sets `system/feeder/status = 1` (tells the device to feed).
3. Removes that reservation from the list.
4. Cleans up any old reservations that are in the past.
5. Sends Telegram:

   ```text
   📅 Reservation Feed Executed
   👤 User: {reservation.user}
   ⏰ {now}
   ```

6. Returns:

   ```json
   {
     "ok": true,
     "type": "reservation",
     "user": "...",
     "scheduledTime": "..."
   }
   ```

If no reservation is ready, the backend moves on to **auto feed**.

---

## 9. Priority 3 – Auto feed

If there is **no reservation feed** to run, the backend checks auto feed:

1. Makes sure:
   - `lastFeedTime` is valid,
   - `cooldownMs > 0`,
   - device is **online**.
2. Calculates:

   - `nextFeedTime = lastFeedTime + cooldownMs`
   - `realAutoFeedTime = nextFeedTime + autoFeedDelayMs`

3. If `now` is **before** `realAutoFeedTime`, it is **too early**, so no auto feed.
4. If `now` is **after or equal** to `realAutoFeedTime`:

   - Logs that auto feed is executing.
   - Sets `system/feeder/status = 1`.
   - Updates:
     - `system/feeder/lastFeedTime` with the current time (separate fields).
     - `system/feeder/lastFeed` with a formatted date string.
   - Sends Telegram:

     ```text
     🐟 Auto Feed Triggered
     ⏰ {now}
     ⏳ Interval: {cooldownMinutes} min
     🕒 Extra Delay: {delayMinutes} min
     ```

   - Returns:

     ```json
     { "ok": true, "type": "auto", "lastFeedTime": { ... } }
     ```

The physical device (ESP8266) will see `status = 1` and perform the actual motor/feeding.

---

## 10. Cleaning old reservations

If no reservation or auto feed is executed, the backend still:

1. Looks at all reservations.
2. Removes any that have `scheduledTime` in the past.
3. Saves the cleaned list back to `system/feeder/reservations`.

Then it returns:

```json
{ "ok": true, "type": "none", "reason": "no_feed_needed" }
```

---

## 11. Error handling & Telegram alerts

If any unexpected error happens in the cron handler:

- It logs the error on the server.
- It sends a Telegram message:

  ```text
  ❌ CRON ERROR
  ⏰ {now}
  {error.message}
  ```

- It returns:

```json
{ "ok": false, "error": "..." }
```

---

## 12. Summary – who does what?

- **Cron service (FastCron / Vercel):** calls `/api/cron` every minute (or other schedule).
- **Backend (`/api/cron`):**
  - Checks authorization.
  - Reads current state from Firebase.
  - Decides:
    - Reservation feed?
    - Auto feed?
    - Or nothing?
  - Updates `system/feeder` in Firebase.
  - Sends Telegram notifications for important events and errors.
- **Device (ESP8266):**
  - Watches Firebase (e.g., `status` field).
  - When it sees `status = 1`, it physically rotates the motor and feeds the fish.
  - Afterwards, it updates its own data (like uptime, WiFi status, history, etc.).

Together, they create a 24/7 automatic feeding system with clear monitoring via Telegram.


