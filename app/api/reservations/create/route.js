import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { isFastingDay, calculateCooldownMs, calculateScheduledTime, sendReservationCreatedMessage } from '@/lib/utils/feeder.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create Reservation Endpoint
 * POST /api/reservations/create
 * 
 * Add user to reservation queue
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
      console.error('[RESERVATION] Firebase initialization failed:', error.message);
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

    // Load feeder data
    const feederSnapshot = await feederRef.once('value');
    const feederData = feederSnapshot.val() || {};

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
        message: 'Today is a fasting day. Cannot create reservation.',
      });
      return addCorsHeaders(response);
    }

    // Get existing reservations
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

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

      const response = NextResponse.json({
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
      });
      return addCorsHeaders(response);
    }

    // Check 3: Reservation limit (max 20)
    if (validReservations.length >= 20) {
      const response = NextResponse.json({
        success: false,
        error: 'QUEUE_FULL',
        message: 'Maximum 20 reservations reached',
      });
      return addCorsHeaders(response);
    }

    // Calculate scheduled time
    let lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Validate lastFeedTime (Rule 5)
    const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
    if (lastFeedTime < MIN_VALID_EPOCH && lastFeedTime > 0) {
      console.warn('[RESERVATION] Invalid lastFeedTime detected:', lastFeedTime, '- Using current time');
      lastFeedTime = Date.now();
    }

    const scheduledTime = calculateScheduledTime(validReservations, lastFeedTime, cooldownMs);
    const createdAt = Date.now();

    // Create reservation object
    const newReservation = {
      user: user || userEmail || 'Visitor',
      userEmail: userEmail || null,
      deviceId: deviceId || null,
      scheduledTime,
      createdAt,
    };

    // Add to queue
    const updatedReservations = [...validReservations, newReservation];
    await feederRef.child('reservations').set(updatedReservations);

    const position = updatedReservations.length;

    // Send Telegram notification
    await sendReservationCreatedMessage({
      user: user || userEmail || 'Visitor',
      scheduledTime,
      position,
      db,
    });

    const response = NextResponse.json({
      success: true,
      reservation: {
        user: newReservation.user,
        userEmail: newReservation.userEmail,
        deviceId: newReservation.deviceId,
        scheduledTime: newReservation.scheduledTime,
        createdAt: newReservation.createdAt,
        position,
      },
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[RESERVATION] Error:', error);
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

