import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { calculateCooldownMs, calculateScheduledTime } from '@/lib/utils/feeder.js';
import { sendTelegram } from '@/lib/services/telegram.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Update Timer Settings Endpoint
 * PUT /api/settings/timer
 * 
 * Update feed interval (cooldown period)
 */
export async function PUT(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Get request body
    const body = await request.json().catch(() => ({}));
    const hour = parseInt(body.hour, 10);
    const minute = parseInt(body.minute, 10);
    const noFeedDay = body.noFeedDay !== undefined ? (body.noFeedDay === null ? null : parseInt(body.noFeedDay, 10)) : undefined;

    // Validate
    if (isNaN(hour) || hour < 0 || hour > 23) {
      const response = NextResponse.json({
        success: false,
        error: 'INVALID_HOUR',
        message: 'Hour must be between 0 and 23',
      });
      return addCorsHeaders(response);
    }

    if (isNaN(minute) || minute < 0 || minute > 59) {
      const response = NextResponse.json({
        success: false,
        error: 'INVALID_MINUTE',
        message: 'Minute must be between 0 and 59',
      });
      return addCorsHeaders(response);
    }

    if (noFeedDay !== undefined && noFeedDay !== null && (noFeedDay < 0 || noFeedDay > 6)) {
      const response = NextResponse.json({
        success: false,
        error: 'INVALID_NO_FEED_DAY',
        message: 'noFeedDay must be between 0 and 6, or null',
      });
      return addCorsHeaders(response);
    }

    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[SETTINGS] Firebase initialization failed:', error.message);
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

    // Load current data
    const feederSnapshot = await feederRef.once('value');
    const feederData = feederSnapshot.val() || {};

    // Get old values
    const oldHour = feederData.timer?.hour || 0;
    const oldMinute = feederData.timer?.minute || 0;
    const oldNoFeedDay = feederData.timer?.noFeedDay;

    // Update timer settings
    const timerUpdate = {
      hour,
      minute,
    };

    if (noFeedDay !== undefined) {
      timerUpdate.noFeedDay = noFeedDay;
    }

    await feederRef.child('timer').set(timerUpdate);

    // Recalculate all reservation scheduledTimes with new cooldown
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    if (validReservations.length > 0) {
      const lastFeedTime = feederData.lastFeedTime || 0;
      const newCooldownMs = calculateCooldownMs(hour, minute);

      const recalculatedReservations = [];
      let currentScheduledTime = lastFeedTime + newCooldownMs;

      for (const reservation of validReservations) {
        const scheduledTime = Math.max(Date.now(), currentScheduledTime);
        recalculatedReservations.push({
          ...reservation,
          scheduledTime,
        });
        currentScheduledTime = scheduledTime + newCooldownMs;
      }

      await feederRef.child('reservations').set(recalculatedReservations);
    }

    // Send Telegram notification if changed
    const changed = hour !== oldHour || minute !== oldMinute || noFeedDay !== oldNoFeedDay;
    if (changed) {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const noFeedDayStr = noFeedDay !== null && noFeedDay !== undefined ? dayNames[noFeedDay] : 'None';

      await sendTelegram(
        `🐟 <b>FISH FEEDER ALERT</b>\n\n⚙️ Timer Settings Updated\n⏰ Interval: ${hour}:${minute.toString().padStart(2, '0')}\n🚫 Fasting Day: ${noFeedDayStr}\n\nSettings saved successfully.`,
        db
      );
    }

    const response = NextResponse.json({
      success: true,
      timer: {
        hour,
        minute,
        noFeedDay,
      },
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[SETTINGS] Error:', error);
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

