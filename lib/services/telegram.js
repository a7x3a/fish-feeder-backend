/**
 * Telegram Bot service for sending messages
 * Robust error handling and retry logic
 */

/**
 * Format date for display in Iraq timezone (UTC+3, Asia/Baghdad)
 */
export function formatDate(date) {
  if (!date) return 'N/A';
  try {
    if (typeof date === 'number') {
      date = new Date(date);
    }
    // Use Iraq timezone (Asia/Baghdad, UTC+3)
    return date.toLocaleString('en-US', {
      timeZone: 'Asia/Baghdad',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false, // Use 24-hour format
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name !== 'AbortError') {
          throw error;
        }
      }
    } catch (error) {
      // Silently fail - message deletion is not critical
      console.warn(`[TELEGRAM] Error deleting message ${messageId}:`, error.message);
    }
  });

  await Promise.all(deletePromises);
}

/**
 * Send a Telegram message with retry logic and robust error handling
 * Stores message IDs in Firebase and deletes all messages after 10 messages.
 * Returns status object for debugging.
 */
export async function sendTelegram(message, db, retries = 2) {
  // Validate inputs
  if (!message || typeof message !== 'string') {
    console.warn('[TELEGRAM] Invalid message, skipping');
    return { success: false, error: 'INVALID_MESSAGE' };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[TELEGRAM] Missing credentials, skipping notification.');
    console.warn('[TELEGRAM] TELEGRAM_BOT_TOKEN:', token ? 'SET' : 'MISSING');
    console.warn('[TELEGRAM] TELEGRAM_CHAT_ID:', chatId ? 'SET' : 'MISSING');
    return { 
      success: false, 
      error: 'MISSING_CREDENTIALS',
      tokenSet: !!token,
      chatIdSet: !!chatId
    };
  }

  console.log('[TELEGRAM] Sending message:', message.substring(0, 50) + '...');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  // Retry logic
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
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
          const errorText = body.substring(0, 200); // Limit error text length
          console.error(`[TELEGRAM] Failed to send. Status: ${response.status}, Body: ${errorText}`);
          
          // If it's a rate limit or temporary error, retry
          if (response.status === 429 || response.status >= 500) {
            if (attempt < retries) {
              const delay = Math.min(1000 * (attempt + 1), 5000); // Exponential backoff, max 5s
              await new Promise(resolve => setTimeout(resolve, delay));
              continue; // Retry
            }
          }
          return { success: false, error: `HTTP_${response.status}`, status: response.status, body: errorText }; // Give up after retries
        }

        const result = await response.json().catch(() => ({}));
        if (!result.ok || !result.result?.message_id) {
          console.error('[TELEGRAM] Failed to get message ID from response');
          return { success: false, error: 'INVALID_RESPONSE', response: result };
        }

        const messageId = result.result.message_id;

        // Store message ID in Firebase for 10-message limit (non-blocking)
        if (db) {
          // Use setTimeout to make this non-blocking
          setTimeout(async () => {
            try {
              const telegramRef = db.ref('system/telegram');
              const snapshot = await telegramRef.once('value').catch(() => null);
              if (!snapshot) {
                console.warn('[TELEGRAM] Failed to read telegram data from Firebase');
                return;
              }

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
              // Non-critical error - log but don't fail
              console.error('[TELEGRAM] Error managing message IDs:', firebaseError.message);
            }
          }, 0);
        }

        return { success: true, messageId }; // Success - exit retry loop
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          console.warn(`[TELEGRAM] Request timeout (5s) - attempt ${attempt + 1}/${retries + 1}`);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            continue; // Retry
          }
          return { success: false, error: 'TIMEOUT', attempts: attempt + 1 }; // Give up after retries
        }
        throw error;
      }
    } catch (error) {
      console.error(`[TELEGRAM] Error on attempt ${attempt + 1}/${retries + 1}:`, error.message);
      if (attempt < retries) {
        const delay = Math.min(1000 * (attempt + 1), 5000);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // Retry
      }
      // Final attempt failed - log and return
      console.error('[TELEGRAM] All retry attempts failed');
      return { success: false, error: error.message, attempts: attempt + 1 };
    }
  }
  
  // Should never reach here, but just in case
  return { success: false, error: 'UNKNOWN_ERROR' };
}
