import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendAutoFeedMessage, isFastingDay, calculateCooldownMs, isDeviceOnline, canFeed } from '@/lib/utils/feeder.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auto Feed Cron Endpoint
 * POST /api/cron/auto-feed
 * 
 * Execute auto feed if no activity after delay (run every minute)
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

    // Check 5: No reservations exist
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    if (validReservations.length > 0) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'RESERVATIONS_EXIST',
      });
      return addCorsHeaders(response);
    }

    // Check 6: Auto feed delay passed
    const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
    // Calculate cooldown end time (use valid lastFeedTime or current time)
    const validLastFeedTime = lastFeedTime && lastFeedTime > 946684800000 ? lastFeedTime : Date.now();
    const cooldownEndsAt = validLastFeedTime + cooldownMs;
    const autoFeedTime = cooldownEndsAt + autoFeedDelayMs;

    if (Date.now() < autoFeedTime) {
      const response = NextResponse.json({
        success: true,
        executed: false,
        reason: 'AUTO_FEED_DELAY_NOT_PASSED',
      });
      return addCorsHeaders(response);
    }

    // All conditions met - execute auto feed
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
      success: true,
      executed: true,
      feedTime: timestampMs,
      type: 'timer',
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

