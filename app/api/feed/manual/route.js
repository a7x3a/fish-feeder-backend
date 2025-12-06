import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendFeedExecutedMessage, isFastingDay, calculateCooldownMs, isDeviceOnline, canFeed } from '@/lib/utils/feeder.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Firebase timeout wrapper
 * Increased timeouts for better reliability
 */
async function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('firebase_timeout')), ms)
    )
  ]);
}

/**
 * Manual Feed Endpoint
 * POST /api/feed/manual
 * 
 * Execute an immediate manual feed (only if cooldown finished and no reservations)
 */
export async function POST(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const startTime = Date.now();
  let db = null;

  try {
    // Get request body with error handling
    let body;
    try {
      body = await request.json();
    } catch (error) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'Invalid JSON in request body',
      }, { status: 400 }));
    }

    const user = (body.user || 'Visitor').toString().substring(0, 100); // Limit length
    const userEmail = body.userEmail ? body.userEmail.toString().substring(0, 200) : null;
    const deviceId = body.deviceId ? body.deviceId.toString().substring(0, 100) : null;

    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[FEED] Firebase initialization failed:', error.message);
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Failed to initialize database',
      }, { status: 500 }));
    }

    const feederRef = db.ref('system/feeder');
    const deviceRef = db.ref('system/device');

    // Load data with timeout protection
    // Read feeder first (critical), then device (can be slower)
    let feederData, deviceData;
    try {
      const feederSnapshot = await withTimeout(
        feederRef.once('value'),
        8000 // 8 second timeout
      );
      feederData = feederSnapshot.val() || {};

      // Read device data (can fail without breaking feed)
      try {
        const deviceSnapshot = await withTimeout(
          deviceRef.once('value'),
          6000 // 6 second timeout
        );
        deviceData = deviceSnapshot.val() || {};
      } catch (deviceError) {
        console.warn('[FEED] Device read failed, using defaults:', deviceError.message);
        deviceData = {};
      }
    } catch (error) {
      if (error.message === 'firebase_timeout') {
        return addCorsHeaders(NextResponse.json({
          success: false,
          error: 'TIMEOUT',
          message: 'Database read timeout',
        }, { status: 504 }));
      }
      throw error;
    }

    if (!feederData || typeof feederData !== 'object') {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'NO_FEEDER_DATA',
        message: 'Feeder data not found',
      }, { status: 404 }));
    }

    // Check 1: Fasting day
    const noFeedDay = feederData.timer?.noFeedDay;
    if (isFastingDay(noFeedDay)) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'FASTING_DAY',
        message: 'Today is a fasting day. All feeds are skipped.',
      }, { status: 403 }));
    }

    // Check 2: Device online
    const lastSeen = deviceData?.lastSeen;
    if (!isDeviceOnline(lastSeen, deviceData)) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'DEVICE_OFFLINE',
        message: 'Device is offline. Cannot execute feed.',
      }, { status: 503 }));
    }

    // Check 3: Currently feeding
    if (feederData.status === 1) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'ALREADY_FEEDING',
        message: 'Device is currently feeding',
      }, { status: 409 }));
    }

    // Check 4: Cooldown finished (with validation)
    let lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = Number(feederData.timer?.hour) || 0;
    const timerMinute = Number(feederData.timer?.minute) || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Validate lastFeedTime
    const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
    if (lastFeedTime < MIN_VALID_EPOCH && lastFeedTime > 0) {
      console.warn('[FEED] Invalid lastFeedTime detected:', lastFeedTime, '- Using current time');
      lastFeedTime = Date.now();
    }

    if (!canFeed(lastFeedTime, cooldownMs)) {
      const cooldownEndsAt = lastFeedTime + cooldownMs;
      const remainingMs = Math.max(0, cooldownEndsAt - Date.now());
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'COOLDOWN_ACTIVE',
        message: `Cooldown active. Time remaining: ${remainingMinutes} minutes`,
        cooldownEndsAt,
        remainingMinutes,
      }, { status: 429 }));
    }

    // Check 5: No reservations exist (reservations have priority)
    const reservations = Array.isArray(feederData.reservations) ? feederData.reservations : [];
    const validReservations = reservations.filter((r) => r && typeof r === 'object' && r.scheduledTime);

    if (validReservations.length > 0) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'RESERVATIONS_EXIST',
        message: 'Cannot manual feed when reservations exist. Reservations have priority.',
        reservationCount: validReservations.length,
      }, { status: 409 }));
    }

    // All checks passed - execute manual feed
    const now = new Date();
    let timestampMs;
    try {
      const result = await withTimeout(
        triggerFeed({
          type: 'manual',
          user: user || userEmail || 'Visitor',
          db,
          feederRef,
          now,
        }),
        10000 // 10 second timeout for critical feed operation
      );
      timestampMs = result.timestampMs;
    } catch (error) {
      if (error.message === 'firebase_timeout') {
        return addCorsHeaders(NextResponse.json({
          success: false,
          error: 'TIMEOUT',
          message: 'Feed trigger timeout',
        }, { status: 504 }));
      }
      throw error;
    }

    // Send Telegram notification (non-blocking)
    sendFeedExecutedMessage({
      type: 'manual',
      user: user || userEmail || 'Visitor',
      now,
      db,
    }).catch(err => console.error('[FEED] Telegram notification failed:', err.message));

    const elapsed = Date.now() - startTime;
    console.log(`[FEED] Manual feed executed in ${elapsed}ms`);

    return addCorsHeaders(NextResponse.json({
      success: true,
      message: 'Feed executed successfully',
      feedTime: timestampMs,
      type: 'manual',
      user: user || userEmail || 'Visitor',
    }));

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[FEED] Error after ${elapsed}ms:`, error.message);
    
    return addCorsHeaders(NextResponse.json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
    }, { status: 500 }));
  }
}

/**
 * Handle OPTIONS for CORS
 */
export async function OPTIONS(request) {
  return handleCORS(request);
}
