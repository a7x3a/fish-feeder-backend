import { NextResponse } from 'next/server';
import admin from 'firebase-admin';

export const runtime = 'nodejs';

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
 * Delete all Telegram messages by their message IDs.
 */
async function deleteAllTelegramMessages(token, chatId, messageIds) {
  if (!messageIds || messageIds.length === 0) return;

  const deletePromises = messageIds.map(async (messageId) => {
    try {
      const url = `https://api.telegram.org/bot${token}/deleteMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable body>');
        console.warn(
          `[TELEGRAM] Failed to delete message ${messageId}. Status: ${response.status} Body: ${body}`
        );
      }
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
    await telegramRef.set({
      messageIds: [],
      count: 0,
    });

    return { success: true, deleted: messageIds.length };
  } catch (error) {
    console.error('[TELEGRAM] Error clearing messages:', error);
    return { success: false, error: error.message };
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
      headers: {
        'Content-Type': 'application/json',
      },
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

    // Handle /clear command
    if (messageText === '/clear') {
      let db;
      try {
        db = getDatabase();
      } catch (error) {
        console.error('[TELEGRAM] Firebase initialization failed:', error);
        await sendTelegramMessage('❌ Error: Failed to initialize database.');
        return NextResponse.json({ ok: true });
      }

      const result = await clearAllTelegramMessages(db);

      if (result.success) {
        await sendTelegramMessage(
          `✅ <b>Chat Cleared</b>\n🗑️ Deleted <code>${result.deleted}</code> message(s).`
        );
      } else {
        await sendTelegramMessage(`❌ Error: ${result.error}`);
      }

      return NextResponse.json({ ok: true });
    }

    // Unknown command - ignore
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

