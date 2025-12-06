import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { isFastingDay, calculateCooldownMs, calculateScheduledTime, sendReservationCreatedMessage } from '@/lib/utils/feeder.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Firebase timeout wrapper
 */
async function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('firebase_timeout')), ms)
    )
  ]);
}

/**
 * Create Reservation Endpoint
 * POST /api/reservations/create
 * 
 * Add user to reservation queue
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

    const user = (body.user || 'Visitor').toString().substring(0, 100);
    const userEmail = body.userEmail ? body.userEmail.toString().substring(0, 200) : null;
    const deviceId = body.deviceId ? body.deviceId.toString().substring(0, 100) : null;

    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[RESERVATION] Firebase initialization failed:', error.message);
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Failed to initialize database',
      }, { status: 500 }));
    }

    const feederRef = db.ref('system/feeder');

    // Load feeder data with timeout
    let feederData;
    try {
      const feederSnapshot = await withTimeout(
        feederRef.once('value'),
        5000
      );
      feederData = feederSnapshot.val() || {};
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
        message: 'Today is a fasting day. Cannot create reservation.',
      }, { status: 403 }));
    }

    // Get existing reservations
    const reservations = Array.isArray(feederData.reservations) ? feederData.reservations : [];
    const validReservations = reservations.filter((r) => 
      r && typeof r === 'object' && r.scheduledTime
    );

    // Check 2: User/device already has reservation
    const existingReservation = validReservations.find((r) => {
      if (deviceId && r.deviceId === deviceId) return true;
      if (userEmail && r.userEmail === userEmail) return true;
      return false;
    });

    if (existingReservation) {
      const position = validReservations.findIndex((r) => {
        if (deviceId && r.deviceId === deviceId) return true;
        if (userEmail && r.userEmail === userEmail) return true;
        return false;
      }) + 1;

      return addCorsHeaders(NextResponse.json({
        success: true,
        reservation: {
          user: existingReservation.user,
          userEmail: existingReservation.userEmail,
          deviceId: existingReservation.deviceId,
          scheduledTime: existingReservation.scheduledTime,
          createdAt: existingReservation.createdAt,
          position,
        },
        message: 'Reservation already exists',
      }));
    }

    // Check 3: Reservation limit (max 20)
    if (validReservations.length >= 20) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'QUEUE_FULL',
        message: 'Maximum 20 reservations reached',
      }, { status: 429 }));
    }

    // Calculate scheduled time
    let lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = Number(feederData.timer?.hour) || 0;
    const timerMinute = Number(feederData.timer?.minute) || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Validate lastFeedTime
    const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
    if (lastFeedTime < MIN_VALID_EPOCH && lastFeedTime > 0) {
      console.warn('[RESERVATION] Invalid lastFeedTime detected:', lastFeedTime, '- Using current time');
      lastFeedTime = Date.now();
    }

    const scheduledTime = calculateScheduledTime(validReservations, lastFeedTime, cooldownMs);
    const createdAt = Date.now();

    // Validate scheduledTime is in the future
    if (scheduledTime <= Date.now()) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'INVALID_SCHEDULE',
        message: 'Scheduled time must be in the future',
      }, { status: 400 }));
    }

    // Create reservation object
    const newReservation = {
      user: user || userEmail || 'Visitor',
      userEmail: userEmail || null,
      deviceId: deviceId || null,
      scheduledTime,
      createdAt,
    };

    // Add to queue with timeout
    const updatedReservations = [...validReservations, newReservation];
    try {
      await withTimeout(
        feederRef.child('reservations').set(updatedReservations),
        5000
      );
    } catch (error) {
      if (error.message === 'firebase_timeout') {
        return addCorsHeaders(NextResponse.json({
          success: false,
          error: 'TIMEOUT',
          message: 'Database write timeout',
        }, { status: 504 }));
      }
      throw error;
    }

    const position = updatedReservations.length;

    // Send Telegram notification (non-blocking)
    sendReservationCreatedMessage({
      user: user || userEmail || 'Visitor',
      scheduledTime,
      position,
      db,
    }).catch(err => console.error('[RESERVATION] Telegram notification failed:', err.message));

    const elapsed = Date.now() - startTime;
    console.log(`[RESERVATION] Created in ${elapsed}ms`);

    return addCorsHeaders(NextResponse.json({
      success: true,
      reservation: {
        user: newReservation.user,
        userEmail: newReservation.userEmail,
        deviceId: newReservation.deviceId,
        scheduledTime: newReservation.scheduledTime,
        createdAt: newReservation.createdAt,
        position,
      },
    }));

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[RESERVATION] Error after ${elapsed}ms:`, error.message);
    
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
