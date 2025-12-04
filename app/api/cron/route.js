import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Legacy cron endpoint - internally calls scheduler for backward compatibility.
 * FastCron and other services can continue using /api/cron.
 * 
 * This endpoint forwards to the new scheduler endpoint internally.
 */
export async function GET(request) {
  try {
    // Get the base URL
    const url = new URL(request.url);
    const baseUrl = url.origin;
    const schedulerUrl = `${baseUrl}/api/scheduler/run${url.search}`;
    
    // Forward the request to scheduler internally
    const response = await fetch(schedulerUrl, {
      method: 'GET',
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        'x-internal-forward': 'true',
      },
    });
    
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('[CRON] Error forwarding to scheduler:', error);
    return NextResponse.json(
      {
        ok: false,
        error: 'Failed to forward to scheduler',
        message: error.message,
      },
      { status: 500 }
    );
  }
}
