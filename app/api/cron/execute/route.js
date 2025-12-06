import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendReservationExecutedMessage, sendAutoFeedMessage, isFastingDay, calculateCooldownMs, canFeed } from '@/lib/utils/feeder.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Firebase timeout wrapper - prevents hanging operations
 */
async function withTimeout(promise, ms = 3000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('firebase_timeout')), ms)
    )
  ]);
}

/**
 * Check if device is online (lastSeen within 60 seconds)
 * Simplified logic - no blocking, no waiting
 */
function isDeviceOnlineFast(lastSeen, deviceData = {}) {
  if (!lastSeen || lastSeen === 0) {
    // Fallback: check uptime and wifi
    const uptime = deviceData?.uptime || 0;
    const wifi = deviceData?.wifi || 'disconnected';
    return uptime > 0 && wifi === 'connected';
  }

  const SIXTY_SECONDS = 60;
  const nowSeconds = Math.floor(Date.now() / 1000);
  
  // Handle both seconds and milliseconds
  let lastSeenSeconds;
  if (lastSeen > 10000000000) {
    // It's in milliseconds, convert to seconds
    lastSeenSeconds = Math.floor(lastSeen / 1000);
  } else {
    // It's already in seconds
    lastSeenSeconds = lastSeen;
  }
  
  const timeDiff = nowSeconds - lastSeenSeconds;
  return timeDiff < SIXTY_SECONDS;
}

/**
 * Core cron execution logic
 * Returns JSON response in <300ms
 */
async function executeCron(request) {
  const startTime = Date.now();
  console.log('[CRON] start');

  try {
    // Step 1: Verify CRON_SECRET
    const cronSecret = process.env.CRON_SECRET;
    if (!isAuthorizedRequest(request, cronSecret)) {
      console.log('[CRON] unauthorized');
      return NextResponse.json(
        { error: 'UNAUTHORIZED', type: 'none' },
        { status: 401 }
      );
    }

    // Step 2: Initialize database with timeout
    let db;
    try {
      db = getDatabase();
    } catch (error) {
      console.log('[CRON] firebase_init_error');
      return NextResponse.json({
        error: 'DATABASE_ERROR',
        type: 'none',
        reason: 'initialization_failed'
      });
    }

    const feederRef = db.ref('system/feeder');
    const deviceRef = db.ref('system/device');

    // Step 3: Load data with timeout protection
    let feederData, deviceData;
    try {
      const [feederSnapshot, deviceSnapshot] = await withTimeout(
        Promise.all([
          feederRef.once('value'),
          deviceRef.once('value'),
        ]),
        2500 // 2.5 second timeout for reads
      );

      feederData = feederSnapshot.val() || {};
      deviceData = deviceSnapshot.val() || {};
    } catch (error) {
      if (error.message === 'firebase_timeout') {
        console.log('[CRON] firebase_timeout');
        return NextResponse.json({
          error: 'firebase_timeout',
          type: 'none'
        });
      }
      throw error;
    }

    if (!feederData) {
      console.log('[CRON] no_feeder_data');
      return NextResponse.json({
        type: 'none',
        reason: 'NO_FEEDER_DATA'
      });
    }

    // Step 4: Check fasting day
    const noFeedDay = feederData.timer?.noFeedDay;
    if (isFastingDay(noFeedDay)) {
      console.log('[CRON] fasting_day');
      return NextResponse.json({
        type: 'none',
        reason: 'fasting_day'
      });
    }

    // Step 5: Check device online (60 second threshold)
    const lastSeen = deviceData.lastSeen;
    if (!isDeviceOnlineFast(lastSeen, deviceData)) {
      console.log('[CRON] device_offline');
      return NextResponse.json({
        type: 'none',
        reason: 'device_offline'
      });
    }

    // Step 6: Check status before feeding (prevent conflicts)
    if (feederData.status === 1) {
      console.log('[CRON] already_feeding');
      return NextResponse.json({
        type: 'none',
        reason: 'already_feeding'
      });
    }

    // Step 7: Get lastFeedTime and cooldown
    let lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);

    // Step 8: Validate lastFeedTime
    const MIN_VALID_EPOCH = 946684800000; // Jan 1, 2000
    if (lastFeedTime < MIN_VALID_EPOCH && lastFeedTime > 0) {
      lastFeedTime = Date.now();
    }

    // Step 9: Check cooldown finished
    if (!canFeed(lastFeedTime, cooldownMs)) {
      console.log('[CRON] cooldown_active');
      return NextResponse.json({
        type: 'none',
        reason: 'cooldown_active'
      });
    }

    // Step 10: Check reservations (Priority 1)
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

      const now = new Date();

      // Trigger feed with timeout protection
      let timestampMs;
      try {
        const result = await withTimeout(
          triggerFeed({
            type: 'reservation',
            user: reservationUser,
            db,
            feederRef,
            now,
          }),
          2000 // 2 second timeout for feed trigger
        );
        timestampMs = result.timestampMs;
      } catch (error) {
        if (error.message === 'firebase_timeout') {
          console.log('[CRON] firebase_timeout on triggerFeed');
          return NextResponse.json({
            error: 'firebase_timeout',
            type: 'none'
          });
        }
        throw error;
      }

      // Remove executed reservation and recalculate
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

      // Update reservations with timeout
      try {
        await withTimeout(
          feederRef.child('reservations').set(recalculatedReservations),
          2000
        );
      } catch (error) {
        if (error.message === 'firebase_timeout') {
          console.log('[CRON] firebase_timeout on reservations update');
          // Continue anyway - feed was triggered
        } else {
          throw error;
        }
      }

      // Send Telegram notification (non-blocking)
      sendReservationExecutedMessage({
        user: reservationUser,
        now,
        db,
      }).catch(err => console.error('[CRON] Telegram failed:', err));

      const elapsed = Date.now() - startTime;
      console.log(`[CRON] reservation_executed in ${elapsed}ms`);

      return NextResponse.json({
        type: 'reservation',
        user: reservationUser,
      });
    }

    // Step 11: Auto feed (Priority 2 - only if no reservations)
    if (validReservations.length === 0) {
      const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes || 30;
      const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
      
      // Calculate when auto feed should trigger
      let cooldownEndTime;
      if (lastFeedTime === 0 || lastFeedTime < MIN_VALID_EPOCH) {
        cooldownEndTime = Date.now();
      } else {
        cooldownEndTime = lastFeedTime + cooldownMs;
      }
      
      const autoFeedTime = cooldownEndTime + autoFeedDelayMs;

      if (Date.now() >= autoFeedTime) {
        const now = new Date();

        // Execute auto feed with timeout
        try {
          await withTimeout(
            triggerFeed({
              type: 'timer',
              user: 'System',
              db,
              feederRef,
              now,
            }),
            2000
          );
        } catch (error) {
          if (error.message === 'firebase_timeout') {
            console.log('[CRON] firebase_timeout on auto feed');
            return NextResponse.json({
              error: 'firebase_timeout',
              type: 'none'
            });
          }
          throw error;
        }

        // Send Telegram notification (non-blocking)
        sendAutoFeedMessage({ now, db }).catch(err => console.error('[CRON] Telegram failed:', err));

        const elapsed = Date.now() - startTime;
        console.log(`[CRON] auto_feed_executed in ${elapsed}ms`);

        return NextResponse.json({
          type: 'timer',
          user: 'System',
        });
      }
    }

    // Step 12: Nothing to execute
    const elapsed = Date.now() - startTime;
    console.log(`[CRON] done in ${elapsed}ms - no_feed_needed`);

    return NextResponse.json({
      type: 'none',
      reason: 'no_feed_needed',
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`[CRON] error after ${elapsed}ms:`, error.message);
    
    return NextResponse.json(
      {
        error: 'INTERNAL_ERROR',
        type: 'none',
        message: error.message,
      },
      { status: 500 }
    );
  }
}

/**
 * GET handler for FastCron compatibility
 */
export async function GET(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;
  
  const response = await executeCron(request);
  return addCorsHeaders(response);
}

/**
 * POST handler for standard cron calls
 */
export async function POST(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;
  
  const response = await executeCron(request);
  return addCorsHeaders(response);
}

/**
 * Handle OPTIONS for CORS
 */
export async function OPTIONS(request) {
  return handleCORS(request);
}
