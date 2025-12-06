import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { triggerFeed, sendReservationExecutedMessage, sendAutoFeedMessage, isFastingDay, calculateCooldownMs, canFeed } from '@/lib/utils/feeder.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Firebase timeout wrapper - prevents hanging operations
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
    // CRITICAL: Read feeder data first (most important), device is optional
    let feederData;
    try {
      // Read feeder with aggressive timeout (5 seconds max for FastCron)
      const feederSnapshot = await withTimeout(
        feederRef.once('value'),
        5000 // 5 second timeout - FastCron needs fast responses
      );
      feederData = feederSnapshot.val() || {};
    } catch (error) {
      if (error.message === 'firebase_timeout') {
        console.log('[CRON] firebase_timeout on feeder read');
        return NextResponse.json({
          error: 'firebase_timeout',
          type: 'none'
        });
      }
      throw error;
    }

    // Read device data in parallel (non-blocking - don't wait for it)
    // If it fails, we'll use defaults - device check is not critical
    let deviceData = {};
    const deviceReadPromise = deviceRef.once('value')
      .then(snapshot => {
        deviceData = snapshot.val() || {};
      })
      .catch(err => {
        console.warn('[CRON] Device read failed (non-critical):', err.message);
        deviceData = {}; // Use defaults
      });
    
    // Don't wait for device read - continue with feeder data
    // Device check will use defaults if read hasn't completed

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
    // Device read is non-blocking, so check if we have data yet
    // If device data is missing, assume online (graceful degradation for FastCron)
    const lastSeen = deviceData?.lastSeen;
    
    // Only check device if we have lastSeen data (device read completed)
    // If device read is still pending or failed, assume online
    if (lastSeen !== undefined && lastSeen !== null) {
      const isOnline = isDeviceOnlineFast(lastSeen, deviceData);
      if (!isOnline) {
        console.log('[CRON] device_offline');
        return NextResponse.json({
          type: 'none',
          reason: 'device_offline'
        });
      }
    } else {
      // Device data not available yet or read failed - assume online (graceful degradation)
      console.warn('[CRON] Device data not available, assuming online (graceful degradation)');
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

      // Trigger feed with timeout protection (aggressive timeout for FastCron)
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
          7000 // 7 second timeout for feed trigger (FastCron needs fast responses)
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

      // Update reservations with timeout (non-critical - fire and forget)
      // Don't wait for this - feed was already triggered successfully
      setTimeout(() => {
        feederRef.child('reservations').set(recalculatedReservations)
          .then(() => console.log('[CRON] Reservations updated'))
          .catch(error => {
            console.error('[CRON] Error updating reservations (non-critical):', error.message);
            // Continue anyway - feed was triggered successfully
          });
      }, 0);

      // Send Telegram notification (non-blocking but log if it fails)
      sendReservationExecutedMessage({
        user: reservationUser,
        now,
        db,
      }).catch(err => {
        console.error('[CRON] Telegram notification failed:', err.message);
        console.error('[CRON] Telegram error details:', err);
      });

      const elapsed = Date.now() - startTime;
      console.log(`[CRON] reservation_executed in ${elapsed}ms`);

      return NextResponse.json({
        type: 'reservation',
        user: reservationUser,
      });
    }

    // Step 11: Auto feed (Priority 2 - only if no reservations)
    if (validReservations.length === 0) {
      // FIX: Use nullish coalescing (??) instead of || to allow 0 value
      // If autoFeedDelayMinutes is 0, it should trigger immediately after cooldown
      const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes !== undefined 
        ? feederData.priority.autoFeedDelayMinutes 
        : 30;
      const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
      
      // Calculate when auto feed should trigger
      let cooldownEndTime;
      if (lastFeedTime === 0 || lastFeedTime < MIN_VALID_EPOCH) {
        cooldownEndTime = Date.now();
      } else {
        cooldownEndTime = lastFeedTime + cooldownMs;
      }
      
      const autoFeedTime = cooldownEndTime + autoFeedDelayMs;

      // If autoFeedDelayMinutes is 0, trigger immediately after cooldown
      if (Date.now() >= autoFeedTime) {
        const now = new Date();

        // Execute auto feed with timeout (aggressive timeout for FastCron)
        try {
          await withTimeout(
            triggerFeed({
              type: 'timer',
              user: 'System',
              db,
              feederRef,
              now,
            }),
            7000 // 7 second timeout for feed trigger (FastCron needs fast responses)
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

        // Send Telegram notification (non-blocking but log if it fails)
        sendAutoFeedMessage({ now, db }).catch(err => {
          console.error('[CRON] Telegram notification failed:', err.message);
          console.error('[CRON] Telegram error details:', err);
        });

        const elapsed = Date.now() - startTime;
        console.log(`[CRON] auto_feed_executed in ${elapsed}ms`);

        return NextResponse.json({
          type: 'timer',
          user: 'System',
        });
      }
    }

    // Step 12: Nothing to execute
    // This is a NORMAL response - cron checked everything, but no feed is needed right now
    // Reasons could be:
    // - No reservations ready yet (scheduledTime hasn't arrived)
    // - Cooldown still active (lastFeedTime + cooldownMs hasn't passed)
    // - Auto-feed delay hasn't passed (cooldownEndTime + autoFeedDelayMs hasn't passed)
    const elapsed = Date.now() - startTime;
    
    // Log detailed info for debugging
    const reservationsCount = validReservations.length;
    const readyCount = readyReservations.length;
    const cooldownEndsAt = lastFeedTime + cooldownMs;
    const cooldownRemaining = Math.max(0, cooldownEndsAt - Date.now());
    
    // FIX: Use nullish coalescing (??) instead of || to allow 0 value
    const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes !== undefined 
      ? feederData.priority.autoFeedDelayMinutes 
      : 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
    const autoFeedTime = cooldownEndsAt + autoFeedDelayMs;
    const autoFeedRemaining = Math.max(0, autoFeedTime - Date.now());
    
    console.log(`[CRON] done in ${elapsed}ms - no_feed_needed`);
    console.log(`[CRON] Status: ${reservationsCount} total reservations, ${readyCount} ready`);
    console.log(`[CRON] Cooldown remaining: ${Math.floor(cooldownRemaining / 1000)}s`);
    if (validReservations.length === 0) {
      console.log(`[CRON] Auto-feed remaining: ${Math.floor(autoFeedRemaining / 1000)}s`);
    }

    return NextResponse.json({
      type: 'none',
      reason: 'no_feed_needed',
      // Add helpful debug info (optional - can be removed in production)
      debug: {
        reservationsCount,
        readyReservationsCount: readyCount,
        cooldownRemainingMs: cooldownRemaining,
        autoFeedRemainingMs: validReservations.length === 0 ? autoFeedRemaining : null,
      }
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
