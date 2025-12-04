import { NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lazily initialize and return the Firebase Realtime Database instance.
 */
function getDatabase() {
  if (!admin.apps.length) {
    try {
      const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;

      if (!serviceAccountStr || serviceAccountStr === '{}') {
        throw new Error('FIREBASE_SERVICE_ACCOUNT not available');
      }

      const serviceAccount = JSON.parse(serviceAccountStr);

      if (!serviceAccount.project_id) {
        throw new Error('Service account object must contain a string "project_id" property.');
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL:
          process.env.FIREBASE_DB_URL ||
          'https://fishfeeder-81131-default-rtdb.firebaseio.com/',
      });
    } catch (error) {
      console.error('Firebase Admin initialization error:', error);
      throw error;
    }
  }

  return admin.database();
}

/**
 * Convert Firebase timestamp fields (or legacy number) into a JS Date.
 */
function fieldsToDate(fields) {
  if (!fields) return null;

  if (typeof fields === 'number') {
    return new Date(fields);
  }

  if (fields.year && fields.month !== undefined && fields.day !== undefined) {
    const date = new Date(
      fields.year,
      fields.month - 1,
      fields.day,
      fields.hour || 0,
      fields.minute || 0,
      fields.second || 0
    );

    const isValidDate =
      date.getFullYear() === fields.year &&
      date.getMonth() === fields.month - 1 &&
      date.getDate() === fields.day &&
      !Number.isNaN(date.getTime());

    if (isValidDate) return date;
  }

  return null;
}

/**
 * Format date for display.
 */
function formatDate(date) {
  if (!date) return 'N/A';
  try {
    return date.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'N/A';
  }
}

/**
 * Send a Telegram message.
 */
async function sendTelegramMessage(message) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      return { success: false, error: 'Missing Telegram credentials' };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable body>');
      return { success: false, error: `Failed to send: ${body}` };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Delete all Telegram messages by their message IDs.
 */
async function deleteAllTelegramMessages(token, chatId, messageIds) {
  if (!messageIds || messageIds.length === 0) return;

  const deletePromises = messageIds.map(async (messageId) => {
    try {
      const url = `https://api.telegram.org/bot${token}/deleteMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
    } catch (error) {
      console.warn(`[TELEGRAM] Error deleting message ${messageId}:`, error);
    }
  });

  await Promise.all(deletePromises);
}

/**
 * Clear all Telegram messages (used by /clear command).
 */
async function clearAllTelegramMessages(db) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      return { success: false, error: 'Missing Telegram credentials' };
    }

    if (!db) {
      return { success: false, error: 'Database not available' };
    }

    const telegramRef = db.ref('system/telegram');
    const snapshot = await telegramRef.once('value');
    const telegramData = snapshot.val() || {};
    const messageIds = telegramData.messageIds || [];

    if (messageIds.length === 0) {
      return { success: true, deleted: 0 };
    }

    await deleteAllTelegramMessages(token, chatId, messageIds);
    await telegramRef.set({ messageIds: [], count: 0 });

    return { success: true, deleted: messageIds.length };
  } catch (error) {
    console.error('[TELEGRAM] Error clearing messages:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle /status command.
 */
async function handleStatusCommand(db) {
  try {
    const feederRef = db.ref('system/feeder');
    const deviceRef = db.ref('system/device');
    const sensorsRef = db.ref('system/sensors');

    const [feederSnapshot, deviceSnapshot, sensorsSnapshot] = await Promise.all([
      feederRef.once('value'),
      deviceRef.once('value'),
      sensorsRef.once('value'),
    ]);

    const feederData = feederSnapshot.val() || {};
    const deviceData = deviceSnapshot.val() || {};
    const sensors = sensorsSnapshot.val() || {};

    const isOnline = deviceData?.wifi === 'connected' && deviceData?.uptime > 0;
    const deviceStatus = isOnline ? 'online' : 'offline';
    const wifiStatus = deviceData?.wifi || 'disconnected';
    const servoStatus = deviceData?.servo || 'off';
    const uptime = deviceData?.uptime || 0;

    const lastFeedTime = fieldsToDate(feederData.lastFeedTime);
    const timerHours = feederData.timer?.hour || feederData.timerHours || 0;
    const timerMinutes = feederData.timer?.minute || feederData.timerMinutes || 0;
    const cooldownMs = timerHours * 3600000 + timerMinutes * 60000;
    const autoFeedDelayMinutes = feederData.delays?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;

    const nextFeedTime = lastFeedTime
      ? new Date(lastFeedTime.getTime() + cooldownMs + autoFeedDelayMs)
      : null;

    const cooldownHours = Math.floor(cooldownMs / 3600000);
    const cooldownMins = Math.floor((cooldownMs % 3600000) / 60000);
    const cooldownStr = `${cooldownHours}:${cooldownMins.toString().padStart(2, '0')}`;

    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    const message = [
      '📊 <b>SYSTEM STATUS</b>',
      '',
      `<b>Device:</b> ${deviceStatus}`,
      `<b>WiFi:</b> ${wifiStatus}`,
      `<b>Servo:</b> ${servoStatus}`,
      `<b>Uptime:</b> ${uptime} seconds`,
      '',
      `<b>Last Feed:</b> ${formatDate(lastFeedTime)}`,
      `<b>Next Feed:</b> ${formatDate(nextFeedTime)}`,
      `<b>Cooldown:</b> ${cooldownStr}`,
      '',
      `<b>Temperature:</b> ${sensors.temperature || 'N/A'}°C`,
      `<b>TDS:</b> ${sensors.tds || 'N/A'} ppm`,
      '',
      `<b>Reservations:</b> ${validReservations.length}`,
    ].join('\n');

    return message;
  } catch (error) {
    console.error('[TELEGRAM] Error handling /status:', error);
    return '❌ Error: Failed to get system status.';
  }
}

/**
 * Handle /history command.
 */
async function handleHistoryCommand(db) {
  try {
    const feederRef = db.ref('system/feeder');
    const feederSnapshot = await feederRef.once('value');
    const feederData = feederSnapshot.val() || {};
    const history = feederData.history || [];

    if (history.length === 0) {
      return '📜 <b>FEED HISTORY</b>\n\nNo feed history available.';
    }

    const last5 = history.slice(0, 5);
    const lines = ['📜 <b>LAST 5 FEEDS</b>', ''];

    last5.forEach((entry, index) => {
      const date = fieldsToDate(entry.dateFields) || new Date(entry.timestamp);
      const type = entry.type || 'unknown';
      const user = entry.user || 'System';
      const timeStr = formatDate(date);

      lines.push(`${index + 1}. [${type}] ${user} – ${timeStr}`);
    });

    return lines.join('\n');
  } catch (error) {
    console.error('[TELEGRAM] Error handling /history:', error);
    return '❌ Error: Failed to get feed history.';
  }
}

/**
 * Handle /reservations command.
 */
async function handleReservationsCommand(db) {
  try {
    const feederRef = db.ref('system/feeder');
    const feederSnapshot = await feederRef.once('value');
    const feederData = feederSnapshot.val() || {};
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    if (validReservations.length === 0) {
      return '📌 <b>ACTIVE RESERVATIONS</b>\n\nNo active reservations.';
    }

    const lines = ['📌 <b>ACTIVE RESERVATIONS</b>', ''];

    validReservations.forEach((reservation, index) => {
      const scheduledDate = fieldsToDate(reservation.scheduledTime);
      const timeStr = formatDate(scheduledDate);
      const user = reservation.user || 'unknown';
      lines.push(`${index + 1}. ${user} – ${timeStr}`);
    });

    return lines.join('\n');
  } catch (error) {
    console.error('[TELEGRAM] Error handling /reservations:', error);
    return '❌ Error: Failed to get reservations.';
  }
}

/**
 * Handle /help command.
 */
function handleHelpCommand() {
  return [
    '<b>FishFeeder Bot Commands:</b>',
    '/status – Show full system status',
    '/history – Last 5 feed events',
    '/reservations – Active reservation queue',
    '/clear – Clear all bot messages',
    '/help – Available commands',
  ].join('\n');
}

/**
 * Handle Telegram webhook POST requests.
 */
export async function POST(request) {
  try {
    const body = await request.json();

    // Check if it's a message update
    if (!body.message || !body.message.text) {
      return NextResponse.json({ ok: true });
    }

    const messageText = body.message.text.trim();
    const chatId = body.message.chat.id;

    // Verify chat ID matches configured chat ID
    const configuredChatId = process.env.TELEGRAM_CHAT_ID;
    if (String(chatId) !== String(configuredChatId)) {
      console.warn(`[TELEGRAM] Received message from unauthorized chat: ${chatId}`);
      return NextResponse.json({ ok: true });
    }

    let db;
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[TELEGRAM] Firebase initialization failed:', error);
      await sendTelegramMessage('❌ Error: Failed to initialize database.');
      return NextResponse.json({ ok: true });
    }

    let responseMessage = '';

    // Handle commands
    if (messageText === '/status') {
      responseMessage = await handleStatusCommand(db);
    } else if (messageText === '/history') {
      responseMessage = await handleHistoryCommand(db);
    } else if (messageText === '/reservations') {
      responseMessage = await handleReservationsCommand(db);
    } else if (messageText === '/help') {
      responseMessage = handleHelpCommand();
    } else if (messageText === '/clear') {
      const result = await clearAllTelegramMessages(db);
      if (result.success) {
        responseMessage = `✅ <b>Chat Cleared</b>\n🗑️ Deleted <code>${result.deleted}</code> message(s).`;
      } else {
        responseMessage = `❌ Error: ${result.error}`;
      }
    } else {
      // Unknown command - ignore
      return NextResponse.json({ ok: true });
    }

    if (responseMessage) {
      await sendTelegramMessage(responseMessage);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[TELEGRAM] Webhook error:', error);
    return NextResponse.json({ ok: true });
  }
}

/**
 * Handle GET requests (for webhook verification).
 */
export async function GET() {
  return NextResponse.json({
    message: 'Telegram webhook endpoint. Use POST to send updates.',
  });
}
