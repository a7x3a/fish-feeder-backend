import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendReservationExecutedMessage, isFastingDay, calculateCooldownMs, isDeviceOnline, canFeed } from '@/lib/utils/feeder.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Execute Reservations Cron Endpoint
 * POST /api/cron/execute-reservations
 * 
 * Check and execute ready reservations (run every 30 seconds)
 */
export async function POST(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Check authorization
    const cronSecret = process.env.CRON_SECRET;
    if (!isAuthorizedRequest(request, cronSecret)) {
      const response = NextResponse.json(
        { success: false, error: 'UNAUTHORIZED' },
        { status: 401 }
      );
      return addCorsHeaders(response);
    }

    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[CRON] Firebase initialization failed:', error.message);
      const response = NextResponse.json(
        { success: false, error: 'DATABASE_ERROR' },
        { status: 500 }
      );
      return addCorsHeaders(response);
    }

    const feederRef = db.ref('system/feeder');
    const deviceRef = db.ref('system/device');

    // Load data
    const [feederSnapshot, deviceSnapshot] = await Promise.all([
      feederRef.once('value'),
      deviceRef.once('value'),
    ]);

    const feederData = feederSnapshot.val() || {};
    const deviceData = deviceSnapshot.val() || {};

    if (!feederData) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'NO_FEEDER_DATA',
      });
      return addCorsHeaders(response);
    }

    // Check 1: Fasting day
    const noFeedDay = feederData.timer?.noFeedDay;
    if (isFastingDay(noFeedDay)) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'FASTING_DAY',
      });
      return addCorsHeaders(response);
    }

    // Check 2: Device online
    const lastSeen = deviceData.lastSeen;
    if (!isDeviceOnline(lastSeen, deviceData)) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'DEVICE_OFFLINE',
      });
      return addCorsHeaders(response);
    }

    // Check 3: Currently feeding
    if (feederData.status === 1) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'ALREADY_FEEDING',
      });
      return addCorsHeaders(response);
    }

    // Check 4: Cooldown finished (with validation)
    let lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Validate lastFeedTime (Rule 5)
    const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
    if (lastFeedTime < MIN_VALID_EPOCH && lastFeedTime > 0) {
      console.warn('[CRON] Invalid lastFeedTime detected:', lastFeedTime, '- Using current time');
      lastFeedTime = Date.now();
    }

    if (!canFeed(lastFeedTime, cooldownMs)) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'COOLDOWN_ACTIVE',
      });
      return addCorsHeaders(response);
    }

    // Get ready reservations (scheduledTime <= now)
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    const readyReservations = validReservations
      .filter((r) => {
        const scheduledTime = typeof r.scheduledTime === 'number' 
          ? r.scheduledTime 
          : parseInt(r.scheduledTime, 10);
        return scheduledTime <= Date.now();
      })
      .sort((a, b) => {
        // Sort by createdAt (FIFO - oldest first)
        const createdAtA = typeof a.createdAt === 'number' ? a.createdAt : parseInt(a.createdAt, 10);
        const createdAtB = typeof b.createdAt === 'number' ? b.createdAt : parseInt(b.createdAt, 10);
        return (createdAtA || 0) - (createdAtB || 0);
      });

    if (readyReservations.length === 0) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'NO_READY_RESERVATIONS',
      });
      return addCorsHeaders(response);
    }

    // Execute first ready reservation
    const reservation = readyReservations[0];
    const reservationUser = reservation.user || 'unknown';

    // Trigger feed
    const { timestampMs } = await triggerFeed({
      type: 'reservation',
      user: reservationUser,
      db,
      feederRef,
      now,
    });

    // Remove executed reservation
    const reservationCreatedAt = typeof reservation.createdAt === 'number' 
      ? reservation.createdAt 
      : parseInt(reservation.createdAt, 10);

    const updatedReservations = validReservations.filter((r) => {
      const createdAt = typeof r.createdAt === 'number' ? r.createdAt : parseInt(r.createdAt, 10);
      return createdAt !== reservationCreatedAt;
    });

    // Recalculate remaining reservations' scheduledTimes
    const recalculatedReservations = [];
    let currentScheduledTime = timestampMs + cooldownMs;

    for (const res of updatedReservations) {
      const scheduledTime = Math.max(Date.now(), currentScheduledTime);
      recalculatedReservations.push({
        ...res,
        scheduledTime,
      });
      currentScheduledTime = scheduledTime + cooldownMs;
    }

    await feederRef.child('reservations').set(recalculatedReservations);

    // Send Telegram notification
    await sendReservationExecutedMessage({
      user: reservationUser,
      now,
      db,
    });

    const response = NextResponse.json({
      success: true,
      executed: true,
      reservation: {
        user: reservationUser,
        feedTime: timestampMs,
      },
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[CRON] Error:', error);
    const response = NextResponse.json(
      {
        success: false,
        error: 'INTERNAL_ERROR',
        message: error.message,
      },
      { status: 500 }
    );
    return addCorsHeaders(response);
  }
}

/**
 * Handle OPTIONS for CORS
 */
export async function OPTIONS(request) {
  return handleCORS(request);
}

