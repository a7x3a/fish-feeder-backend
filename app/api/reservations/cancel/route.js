import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { calculateCooldownMs } from '@/lib/utils/feeder.js';
import { sendTelegram } from '@/lib/services/telegram.js';
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
 * Cancel Reservation Endpoint
 * DELETE /api/reservations/cancel
 * 
 * Remove user's reservation from queue
 */
export async function DELETE(request) {
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

    const deviceId = body.deviceId ? body.deviceId.toString().substring(0, 100) : null;
    const userEmail = body.userEmail ? body.userEmail.toString().substring(0, 200) : null;

    if (!deviceId && !userEmail) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'MISSING_PARAMS',
        message: 'deviceId or userEmail required',
      }, { status: 400 }));
    }

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
        8000 // 8 second timeout
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

    // Find reservation
    const reservations = Array.isArray(feederData.reservations) ? feederData.reservations : [];
    const validReservations = reservations.filter((r) => 
      r && typeof r === 'object' && r.scheduledTime
    );

    const reservationIndex = validReservations.findIndex((r) => {
      if (deviceId && r.deviceId === deviceId) return true;
      if (userEmail && r.userEmail === userEmail) return true;
      return false;
    });

    if (reservationIndex === -1) {
      return addCorsHeaders(NextResponse.json({
        success: false,
        error: 'RESERVATION_NOT_FOUND',
        message: 'Reservation not found',
      }, { status: 404 }));
    }

    // Remove reservation
    const removedReservation = validReservations[reservationIndex];
    const updatedReservations = validReservations.filter((_, index) => index !== reservationIndex);

    // Recalculate remaining reservations' scheduledTimes
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

    // Update reservations with timeout
    try {
      await withTimeout(
        feederRef.child('reservations').set(recalculatedReservations),
        8000 // 8 second timeout
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

    // Send Telegram notification (non-blocking)
    const userName = removedReservation.user || 'Unknown';
    sendTelegram(
      `❌ Reservation Cancelled\n👤 User: ${userName}\n\nReservation removed from queue.`,
      db
    ).catch(err => console.error('[RESERVATION] Telegram notification failed:', err.message));

    const elapsed = Date.now() - startTime;
    console.log(`[RESERVATION] Cancelled in ${elapsed}ms`);

    return addCorsHeaders(NextResponse.json({
      success: true,
      message: 'Reservation cancelled successfully',
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
