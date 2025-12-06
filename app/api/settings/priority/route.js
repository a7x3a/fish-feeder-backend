import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { sendTelegram } from '@/lib/services/telegram.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Firebase timeout wrapper
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
 * Update Priority Settings Endpoint
 * PUT /api/settings/priority
 * 
 * Update delay settings
 */
export async function PUT(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    // Get request body
    const body = await request.json().catch(() => ({}));
    const reservationDelayMinutes = parseInt(body.reservationDelayMinutes, 10);
    const autoFeedDelayMinutes = parseInt(body.autoFeedDelayMinutes, 10);

    // Validate
    if (isNaN(reservationDelayMinutes) || reservationDelayMinutes < 0 || reservationDelayMinutes > 60) {
      const response = NextResponse.json({
        success: false,
        error: 'INVALID_RESERVATION_DELAY',
        message: 'reservationDelayMinutes must be between 0 and 60',
      });
      return addCorsHeaders(response);
    }

    if (isNaN(autoFeedDelayMinutes) || autoFeedDelayMinutes < 0 || autoFeedDelayMinutes > 120) {
      const response = NextResponse.json({
        success: false,
        error: 'INVALID_AUTO_FEED_DELAY',
        message: 'autoFeedDelayMinutes must be between 0 and 120',
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

    // Update priority settings with timeout
    try {
      await withTimeout(
        feederRef.child('priority').set({
          reservationDelayMinutes,
          autoFeedDelayMinutes,
        }),
        8000
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

    // Send Telegram notification
    await sendTelegram(
      `🐟 <b>FISH FEEDER ALERT</b>\n\n⚙️ Priority Settings Updated\n📅 Reservation Delay: ${reservationDelayMinutes} min\n⏰ Auto Feed Delay: ${autoFeedDelayMinutes} min\n\nSettings saved successfully.`,
      db
    );

    const response = NextResponse.json({
      success: true,
      priority: {
        reservationDelayMinutes,
        autoFeedDelayMinutes,
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

