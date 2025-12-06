import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendFeedExecutedMessage, isFastingDay, calculateCooldownMs, isDeviceOnline, canFeed } from '@/lib/utils/feeder.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manual Feed Endpoint
 * POST /api/feed/manual
 * 
 * Execute an immediate manual feed (only if cooldown finished and no reservations)
 */
export async function POST(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Get request body
    const body = await request.json().catch(() => ({}));
    const user = body.user || 'Visitor';
    const userEmail = body.userEmail || null;
    const deviceId = body.deviceId || null;

    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[FEED] Firebase initialization failed:', error.message);
      const response = NextResponse.json(
        {
          success: false,
          error: 'DATABASE_ERROR',
          message: 'Failed to initialize database',
        },
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
        success: false,
        error: 'NO_FEEDER_DATA',
        message: 'Feeder data not found',
      });
      return addCorsHeaders(response);
    }

    // Check 1: Fasting day
    const noFeedDay = feederData.timer?.noFeedDay;
    if (isFastingDay(noFeedDay)) {
      const response = NextResponse.json({
        success: false,
        error: 'FASTING_DAY',
        message: 'Today is a fasting day. All feeds are skipped.',
      });
      return addCorsHeaders(response);
    }

    // Check 2: Device online
    const lastSeen = deviceData.lastSeen;
    if (!isDeviceOnline(lastSeen)) {
      const response = NextResponse.json({
        success: false,
        error: 'DEVICE_OFFLINE',
        message: 'Device is offline. Cannot execute feed.',
      });
      return addCorsHeaders(response);
    }

    // Check 3: Currently feeding
    if (feederData.status === 1) {
      const response = NextResponse.json({
        success: false,
        error: 'ALREADY_FEEDING',
        message: 'Device is currently feeding',
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
      console.warn('[FEED] Invalid lastFeedTime detected:', lastFeedTime, '- Using current time');
      lastFeedTime = Date.now();
    }

    if (!canFeed(lastFeedTime, cooldownMs)) {
      // Calculate remaining time (only if lastFeedTime is valid)
      const cooldownEndsAt = lastFeedTime + cooldownMs;
      const remainingMs = cooldownEndsAt - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      const response = NextResponse.json({
        success: false,
        error: 'COOLDOWN_ACTIVE',
        message: `Cooldown active. Time remaining: ${remainingMinutes} minutes`,
        cooldownEndsAt,
      });
      return addCorsHeaders(response);
    }

    // Check 5: No reservations exist (reservations have priority)
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    if (validReservations.length > 0) {
      const response = NextResponse.json({
        success: false,
        error: 'RESERVATIONS_EXIST',
        message: 'Cannot manual feed when reservations exist. Reservations have priority.',
        reservationCount: validReservations.length,
      });
      return addCorsHeaders(response);
    }

    // All checks passed - execute manual feed
    const { timestampMs } = await triggerFeed({
      type: 'manual',
      user: user || userEmail || 'Visitor',
      db,
      feederRef,
      now,
    });

    // Send Telegram notification
    await sendFeedExecutedMessage({
      type: 'manual',
      user: user || userEmail || 'Visitor',
      now,
      db,
    });

    const response = NextResponse.json({
      success: true,
      message: 'Feed executed successfully',
      feedTime: timestampMs,
      type: 'manual',
      user: user || userEmail || 'Visitor',
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[FEED] Error:', error);
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
