import { NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';

/**
 * Send a Telegram message using the bot API.
 * Environment:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 *
 * This helper never throws – it only logs errors.
 */
async function sendTelegram(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn(
        '[CRON][TELEGRAM] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID, skipping notification.'
      );
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>');
      console.error(
        `[CRON][TELEGRAM] Failed to send message. Status: ${response.status} Body: ${body}`
      );
    }
  } catch (error) {
    console.error('[CRON][TELEGRAM] Error while sending message:', error);
  }
}

/**
 * Lazily initialize and return the Firebase Realtime Database instance.
 * This only runs when the route is called (not during build).
 */
function getDatabase() {
  if (!admin.apps.length) {
    try {
      const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;

      // Skip initialization during build time (when env vars are not available)
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
      fields.month - 1, // JavaScript months are 0-indexed
      fields.day,
      fields.hour || 0,
      fields.minute || 0,
      fields.second || 0
    );

    // Validate date (check if it's a valid date)
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
 * Determine whether the incoming request is authorized to trigger cron logic.
 * Supports:
 * - Vercel-like cron header: x-vercel-cron: 1
 * - Authorization: Bearer <CRON_SECRET>
 * - ?secret=CRON_SECRET query parameter (for external cron providers)
 */
function isAuthorizedCronRequest(request, cronSecret) {
  if (!cronSecret || process.env.NODE_ENV !== 'production') {
    // In development or without a secret we skip auth entirely
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
 * Fetch feeder and device data from Firebase.
 */
async function getFeederAndDevice(db) {
  const feederRef = db.ref('system/feeder');

  const [feederSnapshot, deviceSnapshot] = await Promise.all([
    feederRef.once('value'),
    db.ref('system/device').once('value'),
  ]);

  return {
    feederRef,
    feederData: feederSnapshot.val(),
    deviceData: deviceSnapshot.val(),
  };
}

/**
 * Determine whether it's currently a configured fasting day.
 */
function isTodayFastingDay(fastingDay, now) {
  if (fastingDay === null || fastingDay === undefined) return false;
  return now.getDay() === fastingDay;
}

/**
 * Handle reservation-based feeds (PRIORITY 2).
 */
async function handleReservationFeeds({
  now,
  feederRef,
  feederData,
  isDeviceOnline,
}) {
  const reservations = feederData.reservations || [];
  const validReservations = reservations.filter(
    (reservation) => reservation && reservation.scheduledTime
  );

  if (validReservations.length === 0) {
    return { handled: false };
  }

  const readyReservations = validReservations
    .filter((reservation) => {
      const scheduledDate = fieldsToDate(reservation.scheduledTime);
      return scheduledDate && scheduledDate <= now;
    })
    .sort((a, b) => {
      const createdAtA = fieldsToDate(a.createdAt || a.scheduledTime);
      const createdAtB = fieldsToDate(b.createdAt || b.scheduledTime);
      return (createdAtA?.getTime() || 0) - (createdAtB?.getTime() || 0);
    });

  if (readyReservations.length === 0 || !isDeviceOnline) {
    // Nothing ready to execute, but still return list for cleanup later
    return { handled: false, validReservations };
  }

  const reservation = readyReservations[0];
  console.log(`[CRON] Executing reservation feed for user: ${reservation.user}`);

  await feederRef.child('status').set(1);

  await sendTelegram(
    [
      '📅 Reservation Feed Executed',
      `👤 User: ${reservation.user ?? 'unknown'}`,
      `⏰ ${now.toISOString()}`,
    ].join('\n')
  );

  const reservationCreatedAt = fieldsToDate(
    reservation.createdAt || reservation.scheduledTime
  );
  const reservationCreatedAtTime = reservationCreatedAt?.getTime();

  const updatedReservations = validReservations.filter((current) => {
    const createdAt = fieldsToDate(
      current.createdAt || current.scheduledTime
    );
    return createdAt?.getTime() !== reservationCreatedAtTime;
  });

  await feederRef.child('reservations').set(updatedReservations);

  const cleanedReservations = updatedReservations.filter((current) => {
    const scheduledDate = fieldsToDate(current.scheduledTime);
    return scheduledDate && scheduledDate > now;
  });

  if (cleanedReservations.length !== updatedReservations.length) {
    await feederRef.child('reservations').set(cleanedReservations);
  }

  return {
    handled: true,
    response: NextResponse.json({
      ok: true,
      type: 'reservation',
      user: reservation.user,
      scheduledTime: reservation.scheduledTime,
    }),
  };
}

/**
 * Handle automatic feeds (PRIORITY 3).
 */
async function handleAutoFeed({
  now,
  feederRef,
  lastFeedTime,
  cooldownMs,
  autoFeedDelayMs,
  isDeviceOnline,
}) {
  if (!lastFeedTime || Number.isNaN(lastFeedTime.getTime()) || cooldownMs <= 0) {
    return null;
  }

  if (!isDeviceOnline) {
    return null;
  }

  const nextFeedTime = new Date(lastFeedTime.getTime() + cooldownMs);
  const realAutoFeedTime = new Date(nextFeedTime.getTime() + autoFeedDelayMs);

  if (now < realAutoFeedTime) {
    return null;
  }

  console.log('[CRON] Executing auto feed');
  await feederRef.child('status').set(1);

  const currentDateFields = getCurrentDateFields();
  await feederRef.child('lastFeedTime').set(currentDateFields);

  const lastFeedStr = `${currentDateFields.year}-${currentDateFields.month}-${currentDateFields.day} ${currentDateFields.hour}:${currentDateFields.minute}:${currentDateFields.second}`;
  await feederRef.child('lastFeed').set(lastFeedStr);

  const cooldownMinutes = Math.round(cooldownMs / 60000);
  const delayMinutes = Math.round(autoFeedDelayMs / 60000);

  await sendTelegram(
    [
      '🐟 Auto Feed Triggered',
      `⏰ ${now.toISOString()}`,
      `⏳ Interval: ${cooldownMinutes} min`,
      `🕒 Extra Delay: ${delayMinutes} min`,
    ].join('\n')
  );

  return NextResponse.json({
    ok: true,
    type: 'auto',
    lastFeedTime: currentDateFields,
  });
}

/**
 * Clean up expired reservations that are scheduled in the past.
 */
async function cleanupExpiredReservations({ now, feederRef, feederData }) {
  const reservations = feederData.reservations || [];
  const validReservations = reservations.filter(
    (reservation) => reservation && reservation.scheduledTime
  );

  if (validReservations.length === 0) {
    return;
  }

  const cleanedReservations = validReservations.filter((reservation) => {
    const scheduledDate = fieldsToDate(reservation.scheduledTime);
    return scheduledDate && scheduledDate > now;
  });

  if (cleanedReservations.length !== validReservations.length) {
    await feederRef.child('reservations').set(cleanedReservations);
    console.log(
      `[CRON] Cleaned ${
        validReservations.length - cleanedReservations.length
      } expired reservations`
    );
  }
}

/**
 * Main cron handler.
 */
export async function GET(request) {
  try {
    const cronSecret = process.env.CRON_SECRET;

    if (!isAuthorizedCronRequest(request, cronSecret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[CRON] Starting feed check...');

    let db;
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[CRON] Firebase initialization failed:', error.message);
      return NextResponse.json(
        {
          ok: false,
          error: 'Firebase initialization failed',
          message: error.message,
        },
        { status: 500 }
      );
    }

    const now = new Date();
    const { feederRef, feederData, deviceData } = await getFeederAndDevice(db);

    if (!feederData) {
      return NextResponse.json({ ok: false, error: 'No feeder data found' });
    }

    const isDeviceOnline =
      deviceData?.wifi === 'connected' && deviceData?.uptime > 0;

    if (!isDeviceOnline) {
      await sendTelegram(
        [
          '⚠️ Device Offline',
          `⏰ ${now.toISOString()}`,
          'Feed actions skipped.',
        ].join('\n')
      );
    }

    const currentStatus = feederData.status || 0;
    if (currentStatus === 1) {
      console.log('[CRON] Device is currently feeding - skipping');
      return NextResponse.json({
        ok: true,
        type: 'none',
        reason: 'already_feeding',
      });
    }

    const lastFeedTime = fieldsToDate(feederData.lastFeedTime);
    if (!lastFeedTime || Number.isNaN(lastFeedTime.getTime())) {
      console.log('[CRON] No valid lastFeedTime - skipping auto feed');
      // Still check reservations though
    }

    const timerHours = feederData.timerHours || 0;
    const timerMinutes = feederData.timerMinutes || 0;
    const cooldownMs = timerHours * 3600000 + timerMinutes * 60000;

    const autoFeedDelayMinutes =
      feederData.delays?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;

    const fastingDay = feederData.fastingDay;
    if (isTodayFastingDay(fastingDay, now)) {
      console.log('[CRON] Fasting day - skipping all feeds');
      await sendTelegram(
        [
          '🕋 Fasting Day',
          `⏰ ${now.toISOString()}`,
          'No feeds will be executed today.',
        ].join('\n')
      );
      return NextResponse.json({
        ok: true,
        type: 'none',
        reason: 'fasting_day',
      });
    }

    // PRIORITY 2: Reservation feeds
    const reservationResult = await handleReservationFeeds({
      now,
      feederRef,
      feederData,
      isDeviceOnline,
    });

    if (reservationResult.handled) {
      return reservationResult.response;
    }

    // PRIORITY 3: Auto feed
    const autoFeedResponse = await handleAutoFeed({
      now,
      feederRef,
      lastFeedTime,
      cooldownMs,
      autoFeedDelayMs,
      isDeviceOnline,
    });

    if (autoFeedResponse) {
      return autoFeedResponse;
    }

    // Cleanup any expired reservations
    await cleanupExpiredReservations({ now, feederRef, feederData });

    return NextResponse.json({
      ok: true,
      type: 'none',
      reason: 'no_feed_needed',
    });
  } catch (error) {
    console.error('[CRON] Error:', error);
    const now = new Date();
    await sendTelegram(
      [
        '❌ CRON ERROR',
        `⏰ ${now.toISOString()}`,
        error?.message ?? 'Unknown error',
      ].join('\n')
    );
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        stack:
          process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}

