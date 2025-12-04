import { NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';

/**
 * Lazily initialize and return the Firebase Realtime Database instance.
 */
function getDatabase() {
  if (!admin.apps.length) {
    try {
      const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;

      if (!serviceAccountStr || serviceAccountStr === '{}') {
        throw new Error('FIREBASE_SERVICE_ACCOUNT not available');
      }

      const serviceAccount = JSON.parse(serviceAccountStr);

      if (!serviceAccount.project_id) {
        throw new Error('Service account object must contain a string "project_id" property.');
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL:
          process.env.FIREBASE_DB_URL ||
          'https://fishfeeder-81131-default-rtdb.firebaseio.com/',
      });
    } catch (error) {
      console.error('Firebase Admin initialization error:', error);
      throw error;
    }
  }

  return admin.database();
}

/**
 * Convert Firebase timestamp fields (or legacy number) into a JS Date.
 */
function fieldsToDate(fields) {
  if (!fields) return null;

  if (typeof fields === 'number') {
    return new Date(fields);
  }

  if (fields.year && fields.month !== undefined && fields.day !== undefined) {
    const date = new Date(
      fields.year,
      fields.month - 1,
      fields.day,
      fields.hour || 0,
      fields.minute || 0,
      fields.second || 0
    );

    const isValidDate =
      date.getFullYear() === fields.year &&
      date.getMonth() === fields.month - 1 &&
      date.getDate() === fields.day &&
      !Number.isNaN(date.getTime());

    if (isValidDate) return date;
  }

  return null;
}

/**
 * Convert JS Date to separate timestamp fields.
 */
function dateToFields(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

/**
 * Get the current time as timestamp fields.
 */
function getCurrentDateFields() {
  return dateToFields(new Date());
}

/**
 * Format date for display.
 */
function formatDate(date) {
  if (!date) return 'N/A';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Send a Telegram message using the bot API with message limit management.
 */
async function sendTelegram(message, db) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn('[SCHEDULER][TELEGRAM] Missing credentials, skipping notification.');
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>');
      console.error(`[SCHEDULER][TELEGRAM] Failed to send. Status: ${response.status}`);
      return;
    }

    const result = await response.json();
    if (!result.ok || !result.result?.message_id) {
      console.error('[SCHEDULER][TELEGRAM] Failed to get message ID');
      return;
    }

    const messageId = result.result.message_id;

    // Store message ID in Firebase for 10-message limit
    if (db) {
      try {
        const telegramRef = db.ref('system/telegram');
        const snapshot = await telegramRef.once('value');
        const telegramData = snapshot.val() || {};
        const messageIds = telegramData.messageIds || [];
        const count = telegramData.count || 0;

        const updatedMessageIds = [...messageIds, messageId];
        const newCount = count + 1;

        if (newCount >= 10) {
          await deleteAllTelegramMessages(token, chatId, updatedMessageIds);
          await telegramRef.set({ messageIds: [], count: 0 });
          console.log('[SCHEDULER][TELEGRAM] Reached 10 messages, cleared all');
        } else {
          await telegramRef.set({
            messageIds: updatedMessageIds,
            count: newCount,
          });
        }
      } catch (firebaseError) {
        console.error('[SCHEDULER][TELEGRAM] Error managing message IDs:', firebaseError);
      }
    }
  } catch (error) {
    console.error('[SCHEDULER][TELEGRAM] Error:', error);
  }
}

/**
 * Delete all Telegram messages by their message IDs.
 */
async function deleteAllTelegramMessages(token, chatId, messageIds) {
  if (!messageIds || messageIds.length === 0) return;

  const deletePromises = messageIds.map(async (messageId) => {
    try {
      const url = `https://api.telegram.org/bot${token}/deleteMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
    } catch (error) {
      console.warn(`[SCHEDULER][TELEGRAM] Error deleting message ${messageId}:`, error);
    }
  });

  await Promise.all(deletePromises);
}

/**
 * Determine whether the incoming request is authorized.
 */
function isAuthorizedRequest(request, cronSecret) {
  if (!cronSecret || process.env.NODE_ENV !== 'production') {
    return true;
  }

  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  const { searchParams } = new URL(request.url);
  const querySecret = searchParams.get('secret');

  return (
    isVercelCron ||
    authHeader === `Bearer ${cronSecret}` ||
    querySecret === cronSecret
  );
}

/**
 * Trigger a feed and update all related data.
 */
async function triggerFeed({ type, user, db, feederRef, now }) {
  console.log(`[SCHEDULER] Triggering ${type} feed for user: ${user}`);

  // Set status to 1 to trigger feed
  await feederRef.child('status').set(1);

  // Wait 3-5 seconds (simulated by delay)
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // Update lastFeedTime
  const currentDateFields = getCurrentDateFields();
  await feederRef.child('lastFeedTime').set(currentDateFields);

  // Update lastFeed as formatted string
  const lastFeedStr = `${currentDateFields.year}-${currentDateFields.month}-${currentDateFields.day} ${currentDateFields.hour}:${currentDateFields.minute}:${currentDateFields.second}`;
  await feederRef.child('lastFeed').set(lastFeedStr);

  // Append to history
  const historyRef = feederRef.child('history');
  const historySnapshot = await historyRef.once('value');
  const history = historySnapshot.val() || [];
  const newHistoryEntry = {
    type,
    user: user || 'System',
    timestamp: now.toISOString(),
    dateFields: currentDateFields,
  };
  const updatedHistory = [newHistoryEntry, ...history].slice(0, 100); // Keep last 100
  await historyRef.set(updatedHistory);

  return { currentDateFields, lastFeedStr };
}

/**
 * Send feed executed Telegram message.
 */
async function sendFeedExecutedMessage({ type, user, now, lastFeedTime, nextFeedTime, cooldownMs, db }) {
  const cooldownHours = Math.floor(cooldownMs / 3600000);
  const cooldownMinutes = Math.floor((cooldownMs % 3600000) / 60000);
  const cooldownStr = `${cooldownHours}:${cooldownMinutes.toString().padStart(2, '0')}`;

  const message = [
    '🐟 <b>FEED EXECUTED</b>',
    `Type: <code>${type}</code>`,
    `User: <code>${user || 'System'}</code>`,
    `Time: <code>${formatDate(now)}</code>`,
    '',
    `Last Feed: <code>${formatDate(lastFeedTime)}</code>`,
    `Next Feed: <code>${formatDate(nextFeedTime)}</code>`,
    `Cooldown: <code>${cooldownStr}</code>`,
  ].join('\n');

  await sendTelegram(message, db);
}

/**
 * Check and send sensor alerts with throttling.
 */
async function checkSensorAlerts({ db, sensors, alertsRef, now }) {
  const alertsSnapshot = await alertsRef.once('value');
  const alerts = alertsSnapshot.val() || {};
  const thirtyMinutesAgo = now.getTime() - 30 * 60 * 1000;

  // Check TDS
  if (sensors?.tds && sensors.tds > 800) {
    const lastTdsAlert = alerts.lastTdsAlert || 0;
    if (lastTdsAlert < thirtyMinutesAgo) {
      await sendTelegram(
        [
          '⚠️ <b>WATER WARNING</b>',
          `TDS is high: <code>${sensors.tds} ppm</code>`,
          'Normal: 200–600 ppm',
        ].join('\n'),
        db
      );
      await alertsRef.child('lastTdsAlert').set(now.getTime());
    }
  }

  // Check Temperature
  if (sensors?.temperature) {
    const temp = sensors.temperature;
    if (temp < 20 || temp > 30) {
      const lastTempAlert = alerts.lastTempAlert || 0;
      if (lastTempAlert < thirtyMinutesAgo) {
        await sendTelegram(
          [
            '⚠️ <b>TEMPERATURE WARNING</b>',
            `Current: <code>${temp}°C</code>`,
            'Safe Range: 20–30°C',
          ].join('\n'),
          db
        );
        await alertsRef.child('lastTempAlert').set(now.getTime());
      }
    }
  }
}

/**
 * Check and send device online/offline alerts with throttling.
 */
async function checkDeviceAlerts({ db, deviceData, alertsRef, now, wasOnline }) {
  const alertsSnapshot = await alertsRef.once('value');
  const alerts = alertsSnapshot.val() || {};
  const fifteenMinutesAgo = now.getTime() - 15 * 60 * 1000;

  const isOnline = deviceData?.wifi === 'connected' && deviceData?.uptime > 0;

  // Device went offline
  if (wasOnline && !isOnline) {
    const lastOfflineAlert = alerts.lastOfflineAlert || 0;
    if (lastOfflineAlert < fifteenMinutesAgo) {
      await sendTelegram(
        [
          '❌ <b>DEVICE OFFLINE</b>',
          'The feeder lost internet connection.',
          '',
          `Uptime: <code>${deviceData?.uptime || 0} seconds</code>`,
        ].join('\n'),
        db
      );
      await alertsRef.child('lastOfflineAlert').set(now.getTime());
    }
  }

  // Device came online
  if (!wasOnline && isOnline) {
    const lastOnlineAlert = alerts.lastOnlineAlert || 0;
    if (lastOnlineAlert < fifteenMinutesAgo) {
      await sendTelegram(
        [
          '🟢 <b>DEVICE ONLINE</b>',
          'Connection restored.',
          '',
          `Last Sync: <code>${formatDate(now)}</code>`,
        ].join('\n'),
        db
      );
      await alertsRef.child('lastOnlineAlert').set(now.getTime());
    }
  }

  return isOnline;
}

/**
 * Main scheduler handler following CRON_LOGIC.md spec.
 */
export async function GET(request) {
  try {
    const now = new Date();
    const cronSecret = process.env.CRON_SECRET;

    if (!isAuthorizedRequest(request, cronSecret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[SCHEDULER] Starting scheduler run...');

    let db;
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[SCHEDULER] Firebase initialization failed:', error.message);
      return NextResponse.json(
        { ok: false, error: 'Firebase initialization failed', message: error.message },
        { status: 500 }
      );
    }

    // STEP 1: Load all data
    const feederRef = db.ref('system/feeder');
    const deviceRef = db.ref('system/device');
    const sensorsRef = db.ref('system/sensors');
    const alertsRef = db.ref('system/alerts');

    const [feederSnapshot, deviceSnapshot, sensorsSnapshot, alertsSnapshot] = await Promise.all([
      feederRef.once('value'),
      deviceRef.once('value'),
      sensorsRef.once('value'),
      alertsRef.once('value'),
    ]);

    const feederData = feederSnapshot.val();
    const deviceData = deviceSnapshot.val();
    const sensors = sensorsSnapshot.val();
    const alerts = alertsSnapshot.val() || {};

    if (!feederData) {
      return NextResponse.json({ ok: false, error: 'No feeder data found' });
    }

    // Get previous online state for comparison
    const wasOnline = alerts.lastKnownOnline || false;

    // STEP 2: Handle Device Offline/Online alerts
    const isOnline = await checkDeviceAlerts({
      db,
      deviceData,
      alertsRef,
      now,
      wasOnline,
    });

    // Update last known online state
    await alertsRef.child('lastKnownOnline').set(isOnline);

    // If device is offline, skip feeding but continue with cleanup
    if (!isOnline) {
      // Clean expired reservations even when offline
      const reservations = feederData.reservations || [];
      const validReservations = reservations.filter((r) => r && r.scheduledTime);
      const cleanedReservations = validReservations.filter((r) => {
        const scheduledDate = fieldsToDate(r.scheduledTime);
        return scheduledDate && scheduledDate > now;
      });

      if (cleanedReservations.length !== validReservations.length) {
        await feederRef.child('reservations').set(cleanedReservations);
      }

      return NextResponse.json({
        ok: true,
        type: 'none',
        reason: 'device_offline',
      });
    }

    // STEP 3: Check if currently feeding (status = 1)
    const currentStatus = feederData.status || 0;
    if (currentStatus === 1) {
      console.log('[SCHEDULER] Device is currently feeding - skipping');
      return NextResponse.json({
        ok: true,
        type: 'none',
        reason: 'already_feeding',
      });
    }

    // Get configuration
    const lastFeedTime = fieldsToDate(feederData.lastFeedTime);
    const timerHours = feederData.timer?.hour || feederData.timerHours || 0;
    const timerMinutes = feederData.timer?.minute || feederData.timerMinutes || 0;
    const cooldownMs = timerHours * 3600000 + timerMinutes * 60000;

    const autoFeedDelayMinutes = feederData.delays?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;

    const fastingDay = feederData.timer?.noFeedDay ?? feederData.fastingDay;

    // Check fasting day
    if (fastingDay !== null && fastingDay !== undefined && now.getDay() === fastingDay) {
      console.log('[SCHEDULER] Fasting day - skipping all feeds');
      return NextResponse.json({
        ok: true,
        type: 'none',
        reason: 'fasting_day',
      });
    }

    // STEP 4: Check Reservation Queue (PRIORITY 2 - FIFO)
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    // Find ready reservations (scheduledTime <= now)
    const readyReservations = validReservations
      .filter((r) => {
        const scheduledDate = fieldsToDate(r.scheduledTime);
        return scheduledDate && scheduledDate <= now;
      })
      .sort((a, b) => {
        // Sort by createdAt (FIFO)
        const createdAtA = fieldsToDate(a.createdAt || a.scheduledTime);
        const createdAtB = fieldsToDate(b.createdAt || b.scheduledTime);
        return (createdAtA?.getTime() || 0) - (createdAtB?.getTime() || 0);
      });

    if (readyReservations.length > 0) {
      const reservation = readyReservations[0];
      const reservationUser = reservation.user || 'unknown';

      // Trigger reservation feed
      const { currentDateFields } = await triggerFeed({
        type: 'reservation',
        user: reservationUser,
        db,
        feederRef,
        now,
      });

      // Remove executed reservation
      const reservationCreatedAt = fieldsToDate(reservation.createdAt || reservation.scheduledTime);
      const reservationCreatedAtTime = reservationCreatedAt?.getTime();

      const updatedReservations = validReservations.filter((r) => {
        const createdAt = fieldsToDate(r.createdAt || r.scheduledTime);
        return createdAt?.getTime() !== reservationCreatedAtTime;
      });

      await feederRef.child('reservations').set(updatedReservations);

      // Calculate next feed time
      const nextFeedTime = lastFeedTime
        ? new Date(lastFeedTime.getTime() + cooldownMs + autoFeedDelayMs)
        : null;

      // Send Telegram notification
      await sendFeedExecutedMessage({
        type: 'reservation',
        user: reservationUser,
        now,
        lastFeedTime: fieldsToDate(currentDateFields),
        nextFeedTime,
        cooldownMs,
        db,
      });

      return NextResponse.json({
        ok: true,
        type: 'reservation',
        user: reservationUser,
        scheduledTime: reservation.scheduledTime,
      });
    }

    // STEP 5: Auto Feed (PRIORITY 3)
    if (lastFeedTime && !Number.isNaN(lastFeedTime.getTime()) && cooldownMs > 0) {
      const nextFeedTime = new Date(lastFeedTime.getTime() + cooldownMs);
      const realAutoFeedTime = new Date(nextFeedTime.getTime() + autoFeedDelayMs);

      if (now >= realAutoFeedTime) {
        // Trigger auto feed
        const { currentDateFields } = await triggerFeed({
          type: 'auto',
          user: 'System',
          db,
          feederRef,
          now,
        });

        const nextAutoFeedTime = new Date(
          fieldsToDate(currentDateFields).getTime() + cooldownMs + autoFeedDelayMs
        );

        // Send Telegram notification
        await sendFeedExecutedMessage({
          type: 'auto',
          user: 'System',
          now,
          lastFeedTime: fieldsToDate(currentDateFields),
          nextFeedTime: nextAutoFeedTime,
          cooldownMs,
          db,
        });

        return NextResponse.json({
          ok: true,
          type: 'auto',
          lastFeedTime: currentDateFields,
        });
      }
    }

    // STEP 6: Sensor Alerts
    await checkSensorAlerts({ db, sensors, alertsRef, now });

    // STEP 7: Clean expired reservations
    const cleanedReservations = validReservations.filter((r) => {
      const scheduledDate = fieldsToDate(r.scheduledTime);
      return scheduledDate && scheduledDate > now;
    });

    if (cleanedReservations.length !== validReservations.length) {
      await feederRef.child('reservations').set(cleanedReservations);
      console.log(
        `[SCHEDULER] Cleaned ${validReservations.length - cleanedReservations.length} expired reservations`
      );
    }

    return NextResponse.json({
      ok: true,
      type: 'none',
      reason: 'no_feed_needed',
    });
  } catch (error) {
    console.error('[SCHEDULER] Error:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}

