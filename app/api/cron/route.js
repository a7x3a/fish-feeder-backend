import { NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  try {
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 'N/A';
  }
}

/**
 * Send a Telegram message using the bot API with message limit management.
 */
async function sendTelegram(message, db) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn('[CRON][TELEGRAM] Missing credentials, skipping notification.');
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
      console.error(`[CRON][TELEGRAM] Failed to send. Status: ${response.status}`);
      return;
    }

    const result = await response.json();
    if (!result.ok || !result.result?.message_id) {
      console.error('[CRON][TELEGRAM] Failed to get message ID');
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
          console.log('[CRON][TELEGRAM] Reached 10 messages, cleared all');
        } else {
          await telegramRef.set({
            messageIds: updatedMessageIds,
            count: newCount,
          });
        }
      } catch (firebaseError) {
        console.error('[CRON][TELEGRAM] Error managing message IDs:', firebaseError);
      }
    }
  } catch (error) {
    console.error('[CRON][TELEGRAM] Error:', error);
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
      console.warn(`[CRON][TELEGRAM] Error deleting message ${messageId}:`, error);
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
  console.log(`[CRON] Triggering ${type} feed for user: ${user}`);

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
  const updatedHistory = [newHistoryEntry, ...history].slice(0, 100);
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
 * Main cron handler with full monitoring.
 */
export async function GET(request) {
  const now = new Date();
  let db = null;

  try {
    const cronSecret = process.env.CRON_SECRET;

    if (!isAuthorizedRequest(request, cronSecret)) {
      await sendTelegram(
        [
          '⚠️ <b>Unauthorized Request</b>',
          `⏰ ${formatDate(now)}`,
          'A request tried to call the cron endpoint without valid authentication.',
        ].join('\n'),
        null
      );
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[CRON] Starting feed check...');

    // Send monitoring message - scheduler started
    try {
      db = getDatabase();
      await sendTelegram(
        [
          '🔄 <b>Scheduler Run Started</b>',
          `⏰ ${formatDate(now)}`,
          'Checking for feeds and system status...',
        ].join('\n'),
        db
      );
    } catch (telegramError) {
      console.warn('[CRON] Could not send start notification:', telegramError);
    }

    try {
      db = getDatabase();
    } catch (error) {
      console.error('[CRON] Firebase initialization failed:', error.message);
      await sendTelegram(
        [
          '❌ <b>CRON ERROR</b>',
          `⏰ ${formatDate(now)}`,
          `Firebase initialization failed: ${error.message}`,
        ].join('\n'),
        null
      );
      return NextResponse.json(
        {
          ok: false,
          error: 'Firebase initialization failed',
          message: error.message,
        },
        { status: 500 }
      );
    }

    // Load all data
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
      await sendTelegram(
        [
          '⚠️ <b>No Feeder Data</b>',
          `⏰ ${formatDate(now)}`,
          'The system/feeder path does not exist or is empty.',
        ].join('\n'),
        db
      );
      return NextResponse.json({ ok: false, error: 'No feeder data found' });
    }

    const isDeviceOnline = deviceData?.wifi === 'connected' && deviceData?.uptime > 0;

    // Check device status
    if (!isDeviceOnline) {
      await sendTelegram(
        [
          '⚠️ <b>Device Offline</b>',
          `⏰ ${formatDate(now)}`,
          'Feed actions skipped. Device is not connected.',
          `WiFi: ${deviceData?.wifi || 'unknown'}`,
          `Uptime: ${deviceData?.uptime || 0} seconds`,
        ].join('\n'),
        db
      );
    }

    // Check if currently feeding
    const currentStatus = feederData.status || 0;
    if (currentStatus === 1) {
      console.log('[CRON] Device is currently feeding - skipping');
      await sendTelegram(
        [
          'ℹ️ <b>Already Feeding</b>',
          `⏰ ${formatDate(now)}`,
          'Device is currently feeding. Skipping this run.',
        ].join('\n'),
        db
      );
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
      console.log('[CRON] Fasting day - skipping all feeds');
      await sendTelegram(
        [
          '🕋 <b>Fasting Day</b>',
          `⏰ ${formatDate(now)}`,
          'No feeds will be executed today (fasting day configured).',
        ].join('\n'),
        db
      );
      return NextResponse.json({
        ok: true,
        type: 'none',
        reason: 'fasting_day',
      });
    }

    // Check Reservation Queue (PRIORITY 2 - FIFO)
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    const readyReservations = validReservations
      .filter((r) => {
        const scheduledDate = fieldsToDate(r.scheduledTime);
        return scheduledDate && scheduledDate <= now;
      })
      .sort((a, b) => {
        const createdAtA = fieldsToDate(a.createdAt || a.scheduledTime);
        const createdAtB = fieldsToDate(b.createdAt || b.scheduledTime);
        return (createdAtA?.getTime() || 0) - (createdAtB?.getTime() || 0);
      });

    if (readyReservations.length > 0 && isDeviceOnline) {
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

    // Auto Feed (PRIORITY 3)
    if (lastFeedTime && !Number.isNaN(lastFeedTime.getTime()) && cooldownMs > 0 && isDeviceOnline) {
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

    // Check sensor alerts
    const thirtyMinutesAgo = now.getTime() - 30 * 60 * 1000;
    if (sensors?.tds && sensors.tds > 800) {
      const lastTdsAlert = alerts.lastTdsAlert || 0;
      if (lastTdsAlert < thirtyMinutesAgo) {
        await sendTelegram(
          [
            '⚠️ <b>WATER WARNING</b>',
            `TDS is high: <code>${sensors.tds} ppm</code>`,
            'Normal: 200–600 ppm',
            `⏰ ${formatDate(now)}`,
          ].join('\n'),
          db
        );
        await alertsRef.child('lastTdsAlert').set(now.getTime());
      }
    }

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
              `⏰ ${formatDate(now)}`,
            ].join('\n'),
            db
          );
          await alertsRef.child('lastTempAlert').set(now.getTime());
        }
      }
    }

    // Clean expired reservations
    const cleanedReservations = validReservations.filter((r) => {
      const scheduledDate = fieldsToDate(r.scheduledTime);
      return scheduledDate && scheduledDate > now;
    });

    if (cleanedReservations.length !== validReservations.length) {
      await feederRef.child('reservations').set(cleanedReservations);
      const cleanedCount = validReservations.length - cleanedReservations.length;
      console.log(`[CRON] Cleaned ${cleanedCount} expired reservations`);
      await sendTelegram(
        [
          '🧹 <b>Reservations Cleaned</b>',
          `⏰ ${formatDate(now)}`,
          `Removed <code>${cleanedCount}</code> expired reservation(s).`,
        ].join('\n'),
        db
      );
    }

    // Send summary if no feed was needed
    await sendTelegram(
      [
        'ℹ️ <b>No Feed Needed</b>',
        `⏰ ${formatDate(now)}`,
        `Device: ${isDeviceOnline ? '✅ Online' : '❌ Offline'}`,
        `Reservations: ${validReservations.length} active`,
        `Last Feed: ${formatDate(lastFeedTime)}`,
        `Status: All checks completed, no feed required.`,
      ].join('\n'),
      db
    );

    return NextResponse.json({
      ok: true,
      type: 'none',
      reason: 'no_feed_needed',
    });
  } catch (error) {
    console.error('[CRON] Error:', error);
    await sendTelegram(
      [
        '❌ <b>CRON ERROR</b>',
        `⏰ ${formatDate(now)}`,
        `Error: ${error?.message || 'Unknown error'}`,
        `Stack: ${error?.stack ? error.stack.substring(0, 200) : 'N/A'}`,
      ].join('\n'),
      db
    );
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
