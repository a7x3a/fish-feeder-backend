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
 * 
 * Also checks if lastSeen might be in milliseconds (legacy format) and handles both
 */
export function isDeviceOnline(lastSeen, deviceData = {}) {
  if (!lastSeen || lastSeen === 0) {
    // If lastSeen is missing, check if device has recent uptime or wifi status
    const uptime = deviceData?.uptime || 0;
    const wifi = deviceData?.wifi || 'disconnected';
    
    // If uptime exists and wifi is connected, device might be online but lastSeen not synced yet
    if (uptime > 0 && wifi === 'connected') {
      console.warn('[FEEDER] lastSeen missing but uptime/wifi suggests online');
      return true; // Give benefit of doubt if other indicators suggest online
    }
    return false;
  }
  
  const TWO_MINUTES = 2 * 60; // 120 seconds
  const nowSeconds = Math.floor(Date.now() / 1000);
  
  // Check if lastSeen is in seconds (normal) or milliseconds (legacy/error)
  // If lastSeen > 10000000000, it's likely in milliseconds (after year 2001)
  let lastSeenSeconds;
  if (lastSeen > 10000000000) {
    // It's in milliseconds, convert to seconds
    lastSeenSeconds = Math.floor(lastSeen / 1000);
    console.warn('[FEEDER] lastSeen appears to be in milliseconds, converting:', lastSeen, '->', lastSeenSeconds);
  } else {
    // It's already in seconds
    lastSeenSeconds = lastSeen;
  }
  
  const timeDiff = nowSeconds - lastSeenSeconds;
  const isOnline = timeDiff < TWO_MINUTES;
  
  if (!isOnline) {
    console.warn('[FEEDER] Device appears offline:', {
      lastSeen,
      lastSeenSeconds,
      nowSeconds,
      timeDiff,
      timeDiffMinutes: (timeDiff / 60).toFixed(1)
    });
  }
  
  return isOnline;
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
  // Validate inputs
  if (!feederRef) {
    throw new Error('feederRef is required');
  }
  if (!now || !(now instanceof Date)) {
    throw new Error('now must be a valid Date object');
  }

  const timestampMs = now.getTime();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const second = now.getSeconds();

  console.log(`[FEEDER] Triggering ${type} feed for user: ${user || 'System'}`);

  try {
    // CRITICAL: Update lastFeedTime FIRST (most important - prevents Arduino overwrite)
    // Use set() with error handling - this is the most critical write
    try {
      await feederRef.child('lastFeedTime').set(timestampMs);
    } catch (error) {
      console.error('[FEEDER] Failed to set lastFeedTime:', error.message);
      throw error; // This is critical - must succeed
    }

    // Update lastFeed and status in parallel (status triggers servo)
    // These can be done together as they don't depend on each other
    // Use Promise.all for speed (FastCron needs fast responses)
    try {
      await Promise.all([
        feederRef.child('lastFeed').set({
          timestamp: timestampMs,
          hour,
          minute,
          second,
        }),
        feederRef.child('status').set(1) // Trigger servo
      ]);
    } catch (error) {
      console.error('[FEEDER] Failed to set lastFeed/status:', error.message);
      throw error; // These are also critical
    }

    // Append to history (non-blocking - don't wait for it)
    const historyRef = feederRef.child('history');
    setTimeout(async () => {
      try {
        const historySnapshot = await historyRef.once('value');
        const history = historySnapshot.val() || [];
        
        // Ensure history is an array
        const historyArray = Array.isArray(history) ? history : [];

        const newHistoryEntry = {
          timestamp: timestampMs,
          type: type, // "manual", "timer", or "reservation"
          user: (user || 'System').toString().substring(0, 100), // Limit length
        };

        // Add to beginning and limit to 20
        const updatedHistory = [newHistoryEntry, ...historyArray].slice(0, 20);
        await historyRef.set(updatedHistory);
      } catch (err) {
        console.error('[FEEDER] Error updating history:', err.message);
      }
    }, 0);

    return { timestampMs, hour, minute, second };
  } catch (error) {
    console.error('[FEEDER] Error in triggerFeed:', error.message);
    throw error;
  }
}

/**
 * Send feed executed Telegram message according to spec format
 */
export async function sendFeedExecutedMessage({ type, user, now, db }) {
  try {
    if (!now || !(now instanceof Date)) {
      console.warn('[FEEDER] Invalid date in sendFeedExecutedMessage');
      return;
    }

    const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
    const safeUser = (user || 'System').toString().substring(0, 100);

    let message;
    if (type === 'manual') {
      message = `✅ Manual Feed
👤 ${safeUser}
🕐 ${timeStr}`;
    } else if (type === 'reservation') {
      message = `🎉 Reservation
👤 ${safeUser}
🕐 ${timeStr}`;
    } else if (type === 'timer') {
      message = `🤖 Auto Feed
🕐 ${timeStr}`;
    } else {
      message = `✅ Feed Executed
👤 ${safeUser}
🕐 ${timeStr}`;
    }

    await sendTelegram(message, db);
  } catch (error) {
    console.error('[FEEDER] Error in sendFeedExecutedMessage:', error.message);
    // Don't throw - Telegram failures shouldn't break the feed
  }
}

/**
 * Send reservation created Telegram message
 */
export async function sendReservationCreatedMessage({ user, scheduledTime, position, db }) {
  try {
    if (!scheduledTime || typeof scheduledTime !== 'number') {
      console.warn('[FEEDER] Invalid scheduledTime in sendReservationCreatedMessage');
      return;
    }

    const scheduledDate = new Date(scheduledTime);
    if (isNaN(scheduledDate.getTime())) {
      console.warn('[FEEDER] Invalid date from scheduledTime');
      return;
    }

    const timeStr = scheduledDate.toLocaleTimeString('en-US', { hour12: false });
    const safeUser = (user || 'Visitor').toString().substring(0, 100);
    const safePosition = Math.max(1, Math.min(999, Number(position) || 1));

    const message = `📝 New Reservation
👤 ${safeUser}
🕐 ${timeStr}
📊 Position #${safePosition}`;

    await sendTelegram(message, db);
  } catch (error) {
    console.error('[FEEDER] Error in sendReservationCreatedMessage:', error.message);
    // Don't throw - Telegram failures shouldn't break the reservation
  }
}

/**
 * Send reservation executed Telegram message
 */
export async function sendReservationExecutedMessage({ user, now, db }) {
  try {
    if (!now || !(now instanceof Date)) {
      console.warn('[FEEDER] Invalid date in sendReservationExecutedMessage');
      return;
    }

    const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
    const safeUser = (user || 'Unknown').toString().substring(0, 100);

    const message = `🎉 Reservation
👤 ${safeUser}
🕐 ${timeStr}`;

    await sendTelegram(message, db);
  } catch (error) {
    console.error('[FEEDER] Error in sendReservationExecutedMessage:', error.message);
    // Don't throw - Telegram failures shouldn't break the feed
  }
}

/**
 * Send auto feed Telegram message
 */
export async function sendAutoFeedMessage({ now, db }) {
  try {
    if (!now || !(now instanceof Date)) {
      console.warn('[FEEDER] Invalid date in sendAutoFeedMessage');
      return;
    }

    const timeStr = now.toLocaleTimeString('en-US', { hour12: false });

    const message = `🤖 Auto Feed
🕐 ${timeStr}`;

    console.log('[FEEDER] Sending auto feed Telegram message');
    await sendTelegram(message, db);
    console.log('[FEEDER] Auto feed Telegram message sent successfully');
  } catch (error) {
    console.error('[FEEDER] Error in sendAutoFeedMessage:', error.message);
    console.error('[FEEDER] Error stack:', error.stack);
    // Don't throw - Telegram failures shouldn't break the feed
  }
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
