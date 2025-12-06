import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { isDeviceOnline, sendDeviceOfflineMessage } from '@/lib/utils/feeder.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Check Device Status Cron Endpoint
 * POST /api/cron/check-device
 * 
 * Check device status and send alerts (run every 5 minutes)
 */
export async function POST(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Check authorization
    const cronSecret = process.env.CRON_SECRET;
    if (!isAuthorizedRequest(request, cronSecret)) {
      const response = NextResponse.json(
        { success: false, error: 'UNAUTHORIZED' },
        { status: 401 }
      );
      return addCorsHeaders(response);
    }

    // Initialize database
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[CRON] Firebase initialization failed:', error.message);
      const response = NextResponse.json(
        { success: false, error: 'DATABASE_ERROR' },
        { status: 500 }
      );
      return addCorsHeaders(response);
    }

    const deviceRef = db.ref('system/device');
    const alertsRef = db.ref('system/alerts');

    // Load device data
    const deviceSnapshot = await deviceRef.once('value');
    const deviceData = deviceSnapshot.val() || {};

    const lastSeen = deviceData.lastSeen;
    const isOnline = isDeviceOnline(lastSeen);

    // Check alerts for throttling
    const alertsSnapshot = await alertsRef.once('value');
    const alerts = alertsSnapshot.val() || {};
    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;

    // Send offline alert if needed
    if (!isOnline) {
      const lastOfflineAlert = alerts.lastOfflineAlert || 0;
      if (lastOfflineAlert < fifteenMinutesAgo) {
        await sendDeviceOfflineMessage({ lastSeen, db });
        await alertsRef.child('lastOfflineAlert').set(Date.now());
      }
    }

    const response = NextResponse.json({
      success: true,
      device: {
        online: isOnline,
        lastSeen,
        wifi: deviceData.wifi || 'unknown',
        uptime: deviceData.uptime || 0,
      },
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[CRON] Error:', error);
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

