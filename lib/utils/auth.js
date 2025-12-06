/**
 * Authentication utilities
 */

/**
 * Determine whether the incoming request is authorized
 */
export function isAuthorizedRequest(request, cronSecret) {
  if (!cronSecret || process.env.NODE_ENV !== 'production') {
    return true;
  }

  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  const { searchParams } = new URL(request.url);
  const querySecret = searchParams.get('secret');

  return (
    isVercelCron ||
    authHeader === `Bearer ${cronSecret}` ||
    querySecret === cronSecret
  );
}

