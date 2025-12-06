/**
 * Firebase Admin SDK service
 * Robust initialization with error handling
 */
import admin from 'firebase-admin';

let dbInstance = null;
let initAttempted = false;

/**
 * Lazily initialize and return the Firebase Realtime Database instance.
 * Ensures initialization only happens once and handles errors gracefully.
 */
export function getDatabase() {
  // Return cached instance if already initialized
  if (dbInstance) {
    return dbInstance;
  }

  // If already attempted and failed, throw immediately
  if (initAttempted && !admin.apps.length) {
    throw new Error('Firebase initialization previously failed');
  }

  try {
    // Check if already initialized
    if (admin.apps.length > 0) {
      dbInstance = admin.database();
      return dbInstance;
    }

    initAttempted = true;

    const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountStr || serviceAccountStr === '{}' || serviceAccountStr.trim() === '') {
      throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set or empty');
    }

    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountStr);
    } catch (parseError) {
      throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT JSON: ${parseError.message}`);
    }

    if (!serviceAccount || typeof serviceAccount !== 'object') {
      throw new Error('FIREBASE_SERVICE_ACCOUNT must be a valid JSON object');
    }

    if (!serviceAccount.project_id || typeof serviceAccount.project_id !== 'string') {
      throw new Error('Service account object must contain a string "project_id" property');
    }

    if (!serviceAccount.private_key || typeof serviceAccount.private_key !== 'string') {
      throw new Error('Service account object must contain a string "private_key" property');
    }

    if (!serviceAccount.client_email || typeof serviceAccount.client_email !== 'string') {
      throw new Error('Service account object must contain a string "client_email" property');
    }

    const databaseURL = process.env.FIREBASE_DB_URL || 
      'https://fishfeeder-81131-default-rtdb.firebaseio.com/';

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: databaseURL,
    });

    dbInstance = admin.database();
    console.log('[FIREBASE] Initialized successfully');
    return dbInstance;

  } catch (error) {
    console.error('[FIREBASE] Initialization error:', error.message);
    initAttempted = true; // Mark as attempted to prevent retry loops
    throw error;
  }
}

