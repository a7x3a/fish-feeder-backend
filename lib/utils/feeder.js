/**
 * Feeder utility functions according to README_BACKEND_API.md
 */
import { sendTelegram, formatDate } from '../services/telegram.js';

/**
 * Check if today is fasting day
 */
export function isFastingDay(noFeedDay) {
  if (noFeedDay === null || noFeedDay < 0 || noFeedDay > 6) {
    return false;
  }
  const today = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return today === noFeedDay;
}

/**
 * Check if device is online (lastSeen within 2 minutes)
 * CRITICAL: Arduino stores lastSeen in SECONDS (not milliseconds)
 */
export function isDeviceOnline(lastSeenSeconds) {
  if (!lastSeenSeconds) return false;
  const TWO_MINUTES = 2 * 60; // 120 seconds
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (nowSeconds - lastSeenSeconds) < TWO_MINUTES;
}

/**
 * Calculate cooldown in milliseconds
 */
export function calculateCooldownMs(timerHour, timerMinute) {
  return (timerHour * 3600000) + (timerMinute * 60000);
}

/**
 * Validate lastFeedTime is a valid epoch timestamp
 * Arduino millis() can overwrite with invalid values (< year 2000)
 */
export function isValidLastFeedTime(lastFeedTime) {
  if (!lastFeedTime || lastFeedTime === 0) return true; // No feed yet, allow
  
  // Minimum valid epoch: Jan 1, 2000 (946684800000 ms)
  const MIN_VALID_EPOCH = 946684800000;
  return lastFeedTime >= MIN_VALID_EPOCH;
}

/**
 * Check if cooldown has finished, with validation
 */
export function canFeed(lastFeedTime, cooldownMs) {
  if (!lastFeedTime || lastFeedTime === 0) return true;
  
  // Validate lastFeedTime is epoch (not millis from Arduino)
  if (!isValidLastFeedTime(lastFeedTime)) {
    console.warn('[FEEDER] Invalid lastFeedTime detected:', lastFeedTime, '- Allowing feed');
    return true; // Allow feed if invalid (Arduino overwrote it)
  }
  
  const now = Date.now();
  return now >= lastFeedTime + cooldownMs;
}

/**
 * Calculate scheduled time for new reservation
 */
export function calculateScheduledTime(reservations, lastFeedTime, cooldownMs) {
  const now = Date.now();
  
  if (reservations.length > 0) {
    // Schedule after last reservation
    const lastReservation = reservations[reservations.length - 1];
    const lastScheduledTime = typeof lastReservation.scheduledTime === 'number' 
      ? lastReservation.scheduledTime 
      : parseInt(lastReservation.scheduledTime, 10);
    return lastScheduledTime + cooldownMs;
  }
  
  // Schedule after cooldown
  const cooldownEnds = lastFeedTime + cooldownMs;
  return Math.max(now, cooldownEnds);
}

/**
 * Trigger a feed and update all related data according to README_BACKEND_FIX.md
 * CRITICAL: Update lastFeedTime and lastFeed BEFORE setting status = 1
 * lastFeed is an object: {timestamp, hour, minute, second}
 */
export async function triggerFeed({ type, user, db, feederRef, now }) {
  console.log(`[FEEDER] Triggering ${type} feed for user: ${user}`);

  const timestampMs = now.getTime();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const second = now.getSeconds();

  // CRITICAL: Update lastFeedTime FIRST (before triggering servo)
  // This prevents Arduino from overwriting with invalid millis()
  await feederRef.child('lastFeedTime').set(timestampMs);

  // Update lastFeed as object with timestamp, hour, minute, second
  await feederRef.child('lastFeed').set({
    timestamp: timestampMs,
    hour,
    minute,
    second,
  });

  // Append to history
  const historyRef = feederRef.child('history');
  const historySnapshot = await historyRef.once('value');
  const history = historySnapshot.val() || [];

  const newHistoryEntry = {
    timestamp: timestampMs,
    type: type, // "manual", "timer", or "reservation"
    user: user || 'System',
  };

  // Add to beginning and limit to 20
  const updatedHistory = [newHistoryEntry, ...history].slice(0, 20);
  await historyRef.set(updatedHistory);

  // THEN trigger the servo (Arduino will detect status = 1 and auto-reset to 0)
  await feederRef.child('status').set(1);

  return { timestampMs, hour, minute, second };
}

/**
 * Send feed executed Telegram message according to spec format
 */
export async function sendFeedExecutedMessage({ type, user, now, db }) {
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });

  let message;
  if (type === 'manual') {
    message = `✅ Manual Feed
👤 ${user}
🕐 ${timeStr}`;
  } else if (type === 'reservation') {
    message = `🎉 Reservation
👤 ${user}
🕐 ${timeStr}`;
  } else if (type === 'timer') {
    message = `🤖 Auto Feed
🕐 ${timeStr}`;
  } else {
    message = `✅ Feed Executed
👤 ${user || 'System'}
🕐 ${timeStr}`;
  }

  await sendTelegram(message, db);
}

/**
 * Send reservation created Telegram message
 */
export async function sendReservationCreatedMessage({ user, scheduledTime, position, db }) {
  const scheduledDate = new Date(scheduledTime);
  const timeStr = scheduledDate.toLocaleTimeString('en-US', { hour12: false });

  const message = `📝 New Reservation
👤 ${user}
🕐 ${timeStr}
📊 Position #${position}`;

  await sendTelegram(message, db);
}

/**
 * Send reservation executed Telegram message
 */
export async function sendReservationExecutedMessage({ user, now, db }) {
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });

  const message = `🎉 Reservation
👤 ${user}
🕐 ${timeStr}`;

  await sendTelegram(message, db);
}

/**
 * Send auto feed Telegram message
 */
export async function sendAutoFeedMessage({ now, db }) {
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });

  const message = `🤖 Auto Feed
🕐 ${timeStr}`;

  await sendTelegram(message, db);
}

/**
 * Send device offline Telegram message
 */
export async function sendDeviceOfflineMessage({ lastSeen, db }) {
  if (!lastSeen) return;
  
  // lastSeen is in seconds, convert to milliseconds for Date
  const lastSeenDate = new Date(lastSeen * 1000);
  const timeStr = lastSeenDate.toLocaleTimeString('en-US', { hour12: false });

  const message = `⚠️ Device Offline
🕐 Last seen: ${timeStr}`;

  await sendTelegram(message, db);
}

/**
 * Send fasting day Telegram message
 */
export async function sendFastingDayMessage({ noFeedDay, db }) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[noFeedDay] || 'Unknown';

  const message = `🐟 <b>FISH FEEDER ALERT</b>

🚫 Fasting Day Active
📅 Today is ${dayName}
❌ All feeds skipped

🐟 Fish are fasting today.`;

  await sendTelegram(message, db);
}
