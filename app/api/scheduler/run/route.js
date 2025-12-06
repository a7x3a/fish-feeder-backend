import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { sendTelegram, formatDate } from '@/lib/services/telegram.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';
import { triggerFeed, sendReservationExecutedMessage, sendAutoFeedMessage, isFastingDay, calculateCooldownMs, isDeviceOnline, canFeed } from '@/lib/utils/feeder.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Main Scheduler Endpoint
 * GET /api/scheduler/run
 * 
 * Combines execute-reservations and auto-feed logic
 */
export async function GET(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    const cronSecret = process.env.CRON_SECRET;

    if (!isAuthorizedRequest(request, cronSecret)) {
      const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return addCorsHeaders(response);
    }

    console.log('[SCHEDULER] Starting scheduler run...');

    // Initialize database
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
    } catch (error) {
      console.error('[SCHEDULER] Firebase initialization failed:', error.message);
      const response = NextResponse.json(
        { ok: false, error: 'Firebase initialization failed', message: error.message },
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
      const response = NextResponse.json({ ok: false, error: 'No feeder data found' });
      return addCorsHeaders(response);
    }

    // Check fasting day
    const noFeedDay = feederData.timer?.noFeedDay;
    if (isFastingDay(noFeedDay)) {
      const response = NextResponse.json({ ok: true, type: 'none', reason: 'fasting_day' });
      return addCorsHeaders(response);
    }

    // Check device online
    const lastSeen = deviceData.lastSeen;
    if (!isDeviceOnline(lastSeen)) {
      const response = NextResponse.json({ ok: true, type: 'none', reason: 'device_offline' });
      return addCorsHeaders(response);
    }

    // Check if currently feeding
    if (feederData.status === 1) {
      const response = NextResponse.json({ ok: true, type: 'none', reason: 'already_feeding' });
      return addCorsHeaders(response);
    }

    const lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Check cooldown (with validation)
    if (!canFeed(lastFeedTime, cooldownMs)) {
      const response = NextResponse.json({ ok: true, type: 'none', reason: 'cooldown_active' });
      return addCorsHeaders(response);
    }

    // Priority 1: Check reservations
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    const readyReservations = validReservations
      .filter((r) => {
        const scheduledTime = typeof r.scheduledTime === 'number' ? r.scheduledTime : parseInt(r.scheduledTime, 10);
        return scheduledTime <= Date.now();
      })
      .sort((a, b) => {
        const createdAtA = typeof a.createdAt === 'number' ? a.createdAt : parseInt(a.createdAt, 10);
        const createdAtB = typeof b.createdAt === 'number' ? b.createdAt : parseInt(b.createdAt, 10);
        return (createdAtA || 0) - (createdAtB || 0);
      });

    if (readyReservations.length > 0) {
      const reservation = readyReservations[0];
      const reservationUser = reservation.user || 'unknown';

      const { timestampMs } = await triggerFeed({
        type: 'reservation',
        user: reservationUser,
        db,
        feederRef,
        now,
      });

      const reservationCreatedAt = typeof reservation.createdAt === 'number' 
        ? reservation.createdAt 
        : parseInt(reservation.createdAt, 10);

      const updatedReservations = validReservations.filter((r) => {
        const createdAt = typeof r.createdAt === 'number' ? r.createdAt : parseInt(r.createdAt, 10);
        return createdAt !== reservationCreatedAt;
      });

      // Recalculate remaining reservations
      const recalculatedReservations = [];
      let currentScheduledTime = timestampMs + cooldownMs;

      for (const res of updatedReservations) {
        const scheduledTime = Math.max(Date.now(), currentScheduledTime);
        recalculatedReservations.push({ ...res, scheduledTime });
        currentScheduledTime = scheduledTime + cooldownMs;
      }

      await feederRef.child('reservations').set(recalculatedReservations);

      await sendReservationExecutedMessage({ user: reservationUser, now, db });

      const response = NextResponse.json({
        ok: true,
        type: 'reservation',
        user: reservationUser,
        feedTime: timestampMs,
      });
      return addCorsHeaders(response);
    }

    // Priority 3: Auto feed (only if no reservations)
    if (validReservations.length === 0) {
      const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes || 30;
      const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
      // Calculate cooldown end time (use valid lastFeedTime or current time)
      const validLastFeedTime = lastFeedTime && lastFeedTime > 946684800000 ? lastFeedTime : Date.now();
      const cooldownEndsAt = validLastFeedTime + cooldownMs;
      const autoFeedTime = cooldownEndsAt + autoFeedDelayMs;

      if (Date.now() >= autoFeedTime) {
        const { timestampMs } = await triggerFeed({
          type: 'timer',
          user: 'System',
          db,
          feederRef,
          now,
        });

        await sendAutoFeedMessage({ now, db });

        const response = NextResponse.json({
          ok: true,
          type: 'timer',
          feedTime: timestampMs,
        });
        return addCorsHeaders(response);
      }
    }

    // Nothing executed
    const response = NextResponse.json({
      ok: true,
      type: 'none',
      reason: 'no_feed_needed',
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[SCHEDULER] Error:', error);
    const response = NextResponse.json(
      {
        ok: false,
        error: error.message,
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
