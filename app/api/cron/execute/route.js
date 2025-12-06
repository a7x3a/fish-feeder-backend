import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendReservationExecutedMessage, sendAutoFeedMessage, isFastingDay, calculateCooldownMs, isDeviceOnline, canFeed } from '@/lib/utils/feeder.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unified Cron Execute Endpoint
 * POST /api/cron/execute
 * 
 * Handles both reservations and auto-feed execution (called by FastCron every 5 minutes)
 * 
 * Headers: Authorization: Bearer CRON_SECRET
 */
export async function POST(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Step 1: Verify CRON_SECRET
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
        type: 'none',
        reason: 'NO_FEEDER_DATA',
      });
      return addCorsHeaders(response);
    }

    // Step 2: Check fasting day
    const noFeedDay = feederData.timer?.noFeedDay;
    if (isFastingDay(noFeedDay)) {
      const response = NextResponse.json({
        type: 'none',
        reason: 'fasting_day',
      });
      return addCorsHeaders(response);
    }

    // Step 3: Check device online
    const lastSeen = deviceData.lastSeen;
    if (!isDeviceOnline(lastSeen)) {
      const response = NextResponse.json({
        type: 'none',
        reason: 'device_offline',
      });
      return addCorsHeaders(response);
    }

    // Step 4: Check status before feeding (prevent conflicts)
    if (feederData.status === 1) {
      const response = NextResponse.json({
        type: 'none',
        reason: 'already_feeding',
      });
      return addCorsHeaders(response);
    }

    // Step 5: Get lastFeedTime and cooldown
    let lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Step 6: Validate lastFeedTime (Rule 5)
    const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
    if (lastFeedTime < MIN_VALID_EPOCH && lastFeedTime > 0) {
      console.warn('[CRON] Invalid lastFeedTime detected:', lastFeedTime, '- Using current time');
      lastFeedTime = Date.now();
    }

    // Step 7: Check cooldown finished
    if (!canFeed(lastFeedTime, cooldownMs)) {
      const response = NextResponse.json({
        type: 'none',
        reason: 'cooldown_active',
      });
      return addCorsHeaders(response);
    }

    // Step 8: Check reservations (Priority 1)
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

    if (readyReservations.length > 0) {
      // Execute first ready reservation
      const reservation = readyReservations[0];
      const reservationUser = reservation.user || 'unknown';

      // Trigger feed (updates lastFeedTime, lastFeed, then status = 1)
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
        type: 'reservation',
        user: reservationUser,
      });
      return addCorsHeaders(response);
    }

    // Step 9: Auto feed (Priority 2 - only if no reservations)
    // NOTE: We've already passed the cooldown check in Step 7, so we only need to check the delay
    if (validReservations.length === 0) {
      const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes || 30;
      const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
      
      // Calculate when auto feed should trigger
      // Since cooldown already passed, we calculate from when cooldown ended
      let cooldownEndTime;
      if (lastFeedTime === 0 || lastFeedTime < MIN_VALID_EPOCH) {
        // No previous feed - cooldown ended immediately
        cooldownEndTime = Date.now();
      } else {
        // Cooldown ended at lastFeedTime + cooldownMs
        cooldownEndTime = lastFeedTime + cooldownMs;
      }
      
      // Auto feed should trigger after delay from cooldown end
      const autoFeedTime = cooldownEndTime + autoFeedDelayMs;

      console.log('[CRON] Auto feed check:', {
        lastFeedTime,
        cooldownEndTime,
        autoFeedDelayMs,
        autoFeedTime,
        now: Date.now(),
        canTrigger: Date.now() >= autoFeedTime
      });

      if (Date.now() >= autoFeedTime) {
        // Execute auto feed
        const { timestampMs } = await triggerFeed({
          type: 'timer',
          user: 'System',
          db,
          feederRef,
          now,
        });

        // Send Telegram notification
        await sendAutoFeedMessage({ now, db });

        const response = NextResponse.json({
          type: 'timer',
          user: 'System',
        });
        return addCorsHeaders(response);
      } else {
        // Return reason why auto feed didn't trigger
        const remainingMs = autoFeedTime - Date.now();
        const remainingMinutes = Math.ceil(remainingMs / 60000);
        console.log(`[CRON] Auto feed not ready yet. Remaining: ${remainingMinutes} minutes`);
      }
    }

    // Step 10: Nothing to execute
    const response = NextResponse.json({
      type: 'none',
      reason: 'no_feed_needed',
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

