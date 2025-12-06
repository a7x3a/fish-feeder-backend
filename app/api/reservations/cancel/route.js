import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { calculateCooldownMs, calculateScheduledTime } from '@/lib/utils/feeder.js';
import { sendTelegram } from '@/lib/services/telegram.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cancel Reservation Endpoint
 * DELETE /api/reservations/cancel
 * 
 * Remove user's reservation from queue
 */
export async function DELETE(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Get request body
    const body = await request.json().catch(() => ({}));
    const deviceId = body.deviceId || null;
    const userEmail = body.userEmail || null;

    if (!deviceId && !userEmail) {
      const response = NextResponse.json({
        success: false,
        error: 'MISSING_PARAMS',
        message: 'deviceId or userEmail required',
      });
      return addCorsHeaders(response);
    }

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

    // Find reservation
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    const reservationIndex = validReservations.findIndex((r) => {
      if (deviceId && r.deviceId === deviceId) return true;
      if (userEmail && r.userEmail === userEmail) return true;
      return false;
    });

    if (reservationIndex === -1) {
      const response = NextResponse.json({
        success: false,
        error: 'RESERVATION_NOT_FOUND',
        message: 'Reservation not found',
      });
      return addCorsHeaders(response);
    }

    // Remove reservation
    const removedReservation = validReservations[reservationIndex];
    const updatedReservations = validReservations.filter((_, index) => index !== reservationIndex);

    // Recalculate remaining reservations' scheduledTimes
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

    const recalculatedReservations = [];
    let currentScheduledTime = lastFeedTime + cooldownMs;

    for (const reservation of updatedReservations) {
      const scheduledTime = Math.max(Date.now(), currentScheduledTime);
      recalculatedReservations.push({
        ...reservation,
        scheduledTime,
      });
      currentScheduledTime = scheduledTime + cooldownMs;
    }

    await feederRef.child('reservations').set(recalculatedReservations);

    // Send Telegram notification
    await sendTelegram(
      `🐟 <b>FISH FEEDER ALERT</b>\n\n❌ Reservation Cancelled\n👤 User: ${removedReservation.user}\n\nReservation removed from queue.`,
      db
    );

    const response = NextResponse.json({
      success: true,
      message: 'Reservation cancelled successfully',
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

