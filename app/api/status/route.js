import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { calculateCooldownMs, isDeviceOnline } from '@/lib/utils/feeder.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Get System Status Endpoint
 * GET /api/status
 * 
 * Get current system status for frontend
 */
export async function GET(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  let db = null;

  try {
    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[STATUS] Firebase initialization failed:', error.message);
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
    const sensorsRef = db.ref('system/sensors');

    // Load all data
    const [feederSnapshot, deviceSnapshot, sensorsSnapshot] = await Promise.all([
      feederRef.once('value'),
      deviceRef.once('value'),
      sensorsRef.once('value'),
    ]);

    const feederData = feederSnapshot.val() || {};
    const deviceData = deviceSnapshot.val() || {};
    const sensors = sensorsSnapshot.val() || {};

    // Calculate status
    const lastFeedTime = feederData.lastFeedTime || 0;
    const lastFeed = feederData.lastFeed || {};
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = calculateCooldownMs(timerHour, timerMinute);
    const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;

    const cooldownEndsAt = lastFeedTime + cooldownMs;
    const canFeed = Date.now() >= cooldownEndsAt && (feederData.reservations || []).length === 0;
    const autoFeedAt = lastFeedTime + cooldownMs + autoFeedDelayMs;

    const lastSeen = deviceData.lastSeen;
    const isOnline = isDeviceOnline(lastSeen);

    const response = NextResponse.json({
      status: feederData.status || 0,
      lastFeed: lastFeed.timestamp ? {
        timestamp: lastFeed.timestamp,
        hour: lastFeed.hour,
        minute: lastFeed.minute,
        second: lastFeed.second,
      } : null,
      lastFeedTime,
      timer: {
        hour: timerHour,
        minute: timerMinute,
        noFeedDay: feederData.timer?.noFeedDay || null,
      },
      device: {
        wifi: deviceData.wifi || 'disconnected',
        online: isOnline,
        uptime: deviceData.uptime || 0,
        lastSeen,
      },
      sensors: {
        tds: sensors.tds || 0,
        temperature: sensors.temperature || 0,
      },
      reservations: feederData.reservations || [],
      canFeed,
      cooldownEndsAt,
      autoFeedAt,
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[STATUS] Error:', error);
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

