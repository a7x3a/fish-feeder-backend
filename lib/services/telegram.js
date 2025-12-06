/**
 * Telegram Bot service for sending messages
 */

/**
 * Format date for display
 */
export function formatDate(date) {
  if (!date) return 'N/A';
  try {
    if (typeof date === 'number') {
      date = new Date(date);
    }
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 'N/A';
  }
}

/**
 * Delete all Telegram messages by their message IDs
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
 * Send a Telegram message using the bot API with message limit management.
 * Stores message IDs in Firebase and deletes all messages after 10 messages.
 */
export async function sendTelegram(message, db) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn('[TELEGRAM] Missing credentials, skipping notification.');
      return;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    // Add timeout to prevent hanging (5 seconds max)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable body>');
        console.error(`[TELEGRAM] Failed to send. Status: ${response.status}`);
        return;
      }

      const result = await response.json();
      if (!result.ok || !result.result?.message_id) {
        console.error('[TELEGRAM] Failed to get message ID');
        return;
      }

      const messageId = result.result.message_id;

      // Store message ID in Firebase for 10-message limit (non-blocking for cron)
      if (db) {
        // Use setTimeout to make this non-blocking
        setTimeout(async () => {
          try {
            const telegramRef = db.ref('system/telegram');
            const snapshot = await telegramRef.once('value');
            const telegramData = snapshot.val() || {};
            const messageIds = telegramData.messageIds || [];
            const count = telegramData.count || 0;

            const updatedMessageIds = [...messageIds, messageId];
            const newCount = count + 1;

            if (newCount >= 10) {
              await deleteAllTelegramMessages(token, chatId, updatedMessageIds);
              await telegramRef.set({ messageIds: [], count: 0 });
              console.log('[TELEGRAM] Reached 10 messages, cleared all');
            } else {
              await telegramRef.set({
                messageIds: updatedMessageIds,
                count: newCount,
              });
            }
          } catch (firebaseError) {
            console.error('[TELEGRAM] Error managing message IDs:', firebaseError);
          }
        }, 0);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.warn('[TELEGRAM] Request timeout (5s)');
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('[TELEGRAM] Error:', error);
  }
}

