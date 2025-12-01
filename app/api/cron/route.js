import { NextResponse } from 'next/server';
import admin from 'firebase-admin';

// Lazy initialization function - only runs when route is called, not during build
function getDatabase() {
  // Initialize Firebase Admin SDK only if not already initialized
  if (!admin.apps.length) {
    try {
      const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
      
      // Skip initialization during build time (when env vars are not available)
      if (!serviceAccountStr || serviceAccountStr === '{}') {
        throw new Error('FIREBASE_SERVICE_ACCOUNT not available');
      }
      
      const serviceAccount = JSON.parse(serviceAccountStr);
      
      // Validate service account has required fields
      if (!serviceAccount.project_id) {
        throw new Error('Service account object must contain a string "project_id" property.');
      }
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL || 'https://fishfeeder-81131-default-rtdb.firebaseio.com/'
      });
    } catch (error) {
      console.error('Firebase Admin initialization error:', error);
      throw error;
    }
  }
  
  return admin.database();
}

// Helper: Convert Firebase separate time fields into JS Date object
function fieldsToDate(fields) {
  if (!fields) return null;
  
  // Handle legacy timestamp number format
  if (typeof fields === 'number') {
    return new Date(fields);
  }
  
  // Handle separate fields format
  if (fields.year && fields.month !== undefined && fields.day !== undefined) {
    const date = new Date(
      fields.year,
      fields.month - 1, // JavaScript months are 0-indexed
      fields.day,
      fields.hour || 0,
      fields.minute || 0,
      fields.second || 0
    );
    
    // Validate date (check if it's a valid date)
    if (
      date.getFullYear() === fields.year &&
      date.getMonth() === fields.month - 1 &&
      date.getDate() === fields.day &&
      !isNaN(date.getTime())
    ) {
      return date;
    }
  }
  
  return null;
}

// Helper: Convert JS Date to separate fields object
function dateToFields(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds()
  };
}

// Helper: Get current date/time as separate fields
function getCurrentDateFields() {
  return dateToFields(new Date());
}

// Main cron handler
export async function GET(request) {
  try {
    // Verify this is a Vercel Cron request (optional security check)
    // Vercel automatically adds authorization header for cron jobs
    // Skip auth check in local development
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && process.env.NODE_ENV === 'production') {
      const authHeader = request.headers.get('authorization');
      // Vercel cron jobs send: Authorization: Bearer <CRON_SECRET>
      // Or check the x-vercel-cron header
      const isVercelCron = request.headers.get('x-vercel-cron') === '1';
      
      // Support query parameter for external cron services (e.g., cron-job.org)
      const { searchParams } = new URL(request.url);
      const querySecret = searchParams.get('secret');
      
      // Allow if: Vercel cron, Bearer token matches, or query secret matches
      const isValidAuth = isVercelCron || 
                         authHeader === `Bearer ${cronSecret}` || 
                         querySecret === cronSecret;
      
      if (!isValidAuth) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    console.log('[CRON] Starting feed check...');
    
    // Initialize Firebase database (lazy initialization - only when route is called)
    // This prevents Firebase initialization during build time
    let db;
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[CRON] Firebase initialization failed:', error.message);
      return NextResponse.json({ 
        ok: false, 
        error: 'Firebase initialization failed',
        message: error.message 
      }, { status: 500 });
    }
    
    const now = new Date();
    const feederRef = db.ref('system/feeder');
    
    // 1. Load all required data from Firebase
    const [feederSnapshot, deviceSnapshot] = await Promise.all([
      feederRef.once('value'),
      db.ref('system/device').once('value')
    ]);
    
    const feederData = feederSnapshot.val();
    const deviceData = deviceSnapshot.val();
    
    if (!feederData) {
      return NextResponse.json({ ok: false, error: 'No feeder data found' });
    }
    
    // Check if device is online (only execute feeds if device is connected)
    const isDeviceOnline = deviceData?.wifi === 'connected' && deviceData?.uptime > 0;
    
    // Check if currently feeding (status = 1)
    const currentStatus = feederData.status || 0;
    if (currentStatus === 1) {
      console.log('[CRON] Device is currently feeding - skipping');
      return NextResponse.json({ ok: true, type: 'none', reason: 'already_feeding' });
    }
    
    // 2. Convert lastFeedTime to Date object
    const lastFeedTime = fieldsToDate(feederData.lastFeedTime);
    if (!lastFeedTime || isNaN(lastFeedTime.getTime())) {
      console.log('[CRON] No valid lastFeedTime - skipping auto feed');
      // Still check reservations though
    }
    
    // 3. Get timer settings
    const timerHours = feederData.timerHours || 0;
    const timerMinutes = feederData.timerMinutes || 0;
    const cooldownMs = (timerHours * 3600000) + (timerMinutes * 60000);
    
    // 4. Get delays
    const autoFeedDelayMinutes = feederData.delays?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
    
    // 5. Get fasting day
    const fastingDay = feederData.fastingDay;
    const isFastingDay = fastingDay !== null && fastingDay !== undefined && now.getDay() === fastingDay;
    
    if (isFastingDay) {
      console.log('[CRON] Fasting day - skipping all feeds');
      return NextResponse.json({ ok: true, type: 'none', reason: 'fasting_day' });
    }
    
    // PRIORITY 1: Check for manual feed (handled by ESP8266, skip)
    
    // PRIORITY 2: Check for ready reservations (FIFO)
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter(r => r && r.scheduledTime);
    
    // Find ready reservations (scheduledTime <= now)
    const readyReservations = validReservations
      .filter(r => {
        const scheduledDate = fieldsToDate(r.scheduledTime);
        return scheduledDate && scheduledDate <= now;
      })
      .sort((a, b) => {
        // Sort by createdAt (FIFO)
        const createdAtA = fieldsToDate(a.createdAt || a.scheduledTime);
        const createdAtB = fieldsToDate(b.createdAt || b.scheduledTime);
        return (createdAtA?.getTime() || 0) - (createdAtB?.getTime() || 0);
      });
    
    if (readyReservations.length > 0 && isDeviceOnline) {
      // Execute first ready reservation
      const reservation = readyReservations[0];
      console.log(`[CRON] Executing reservation feed for user: ${reservation.user}`);
      
      // Set status to 1 to trigger feed
      await feederRef.child('status').set(1);
      
      // Remove executed reservation from array (match by createdAt for uniqueness)
      const reservationCreatedAt = fieldsToDate(reservation.createdAt || reservation.scheduledTime);
      const reservationCreatedAtTime = reservationCreatedAt?.getTime();
      
      const updatedReservations = validReservations.filter(r => {
        const createdAt = fieldsToDate(r.createdAt || r.scheduledTime);
        return createdAt?.getTime() !== reservationCreatedAtTime;
      });
      
      await feederRef.child('reservations').set(updatedReservations);
      
      // Clean expired reservations while we're at it
      const cleanedReservations = updatedReservations.filter(r => {
        const scheduledDate = fieldsToDate(r.scheduledTime);
        return scheduledDate && scheduledDate > now;
      });
      
      if (cleanedReservations.length !== updatedReservations.length) {
        await feederRef.child('reservations').set(cleanedReservations);
      }
      
      // Note: ESP8266 will update lastFeedTime and add to history after feed executes
      
      return NextResponse.json({ 
        ok: true, 
        type: 'reservation',
        user: reservation.user,
        scheduledTime: reservation.scheduledTime
      });
    }
    
    // PRIORITY 3: Check for auto feed
    if (lastFeedTime && !isNaN(lastFeedTime.getTime()) && cooldownMs > 0 && isDeviceOnline) {
      const nextFeedTime = new Date(lastFeedTime.getTime() + cooldownMs);
      const realAutoFeedTime = new Date(nextFeedTime.getTime() + autoFeedDelayMs);
      
      if (now >= realAutoFeedTime) {
        console.log('[CRON] Executing auto feed');
        
        // Set status to 1 to trigger feed
        await feederRef.child('status').set(1);
        
        // Update lastFeedTime immediately to prevent duplicate triggers
        // ESP8266 will also update it after execution, which is fine (will be same time)
        const currentDateFields = getCurrentDateFields();
        await feederRef.child('lastFeedTime').set(currentDateFields);
        
        // Update lastFeed as formatted string
        const lastFeedStr = `${currentDateFields.year}-${currentDateFields.month}-${currentDateFields.day} ${currentDateFields.hour}:${currentDateFields.minute}:${currentDateFields.second}`;
        await feederRef.child('lastFeed').set(lastFeedStr);
        
        // Note: ESP8266 will also update lastFeedTime and add to history after feed executes
        // This prevents the backend from triggering multiple feeds in subsequent runs
        
        return NextResponse.json({ 
          ok: true, 
          type: 'auto',
          lastFeedTime: currentDateFields
        });
      }
    }
    
    // Clean expired reservations
    if (validReservations.length > 0) {
      const cleanedReservations = validReservations.filter(r => {
        const scheduledDate = fieldsToDate(r.scheduledTime);
        return scheduledDate && scheduledDate > now;
      });
      
      if (cleanedReservations.length !== validReservations.length) {
        await feederRef.child('reservations').set(cleanedReservations);
        console.log(`[CRON] Cleaned ${validReservations.length - cleanedReservations.length} expired reservations`);
      }
    }
    
    return NextResponse.json({ ok: true, type: 'none', reason: 'no_feed_needed' });
    
  } catch (error) {
    console.error('[CRON] Error:', error);
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, { status: 500 });
  }
}

// Export as GET handler for Vercel Cron
export const runtime = 'nodejs';

