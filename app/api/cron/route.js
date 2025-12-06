import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { sendTelegram, formatDate } from '@/lib/services/telegram.js';
import { isAuthorizedRequest } from '@/lib/utils/auth.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Legacy Cron Endpoint
 * GET /api/cron
 * 
 * For backward compatibility - forwards to scheduler
 */
export async function GET(request) {
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  const now = new Date();
  let db = null;

  try {
    const cronSecret = process.env.CRON_SECRET;

    if (!isAuthorizedRequest(request, cronSecret)) {
      const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return addCorsHeaders(response);
    }

    console.log('[CRON] Starting feed check...');

    // Initialize database
    try {
      db = getDatabase();
      await sendTelegram(
        [
          '🔄 <b>Scheduler Run Started</b>',
          `⏰ ${formatDate(now)}`,
          'Checking for feeds and system status...',
        ].join('\n'),
        db
      );
    } catch (error) {
      console.error('[CRON] Firebase initialization failed:', error.message);
      const response = NextResponse.json(
        {
          ok: false,
          error: 'Firebase initialization failed',
          message: error.message,
        },
        { status: 500 }
      );
      return addCorsHeaders(response);
    }

    // Forward to scheduler
    const schedulerUrl = new URL('/api/scheduler/run', request.url);
    const schedulerResponse = await fetch(schedulerUrl.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${cronSecret}`,
      },
    });

    const result = await schedulerResponse.json();
    const response = NextResponse.json(result, {
      status: result.ok ? 200 : 500,
    });

    return addCorsHeaders(response);
  } catch (error) {
    console.error('[CRON] Error:', error);
    const response = NextResponse.json(
      {
        ok: false,
        error: error.message,
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
