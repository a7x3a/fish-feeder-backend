import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/services/firebase.js';
import { formatDate } from '@/lib/services/telegram.js';
import { addCorsHeaders, handleCORS } from '@/lib/utils/cors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
 * Send a Telegram message (simple version without message limit management).
 * Used for command responses in webhook.
 */
async function sendSimpleTelegramMessage(message) {
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

    const lastFeedTime = feederData.lastFeedTime ? new Date(feederData.lastFeedTime) : null;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = timerHour * 3600000 + timerMinute * 60000;
    const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes || 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;

    const cooldownHours = Math.floor(cooldownMs / 3600000);
    const cooldownMins = Math.floor((cooldownMs % 3600000) / 60000);
    const cooldownStr = `${cooldownHours}:${cooldownMins.toString().padStart(2, '0')}`;

    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);

    // Calculate next feed time
    const now = Date.now();
    let nextFeedTime = null;
    let nextFeedType = 'Auto Feed';
    
    if (validReservations.length > 0) {
      const nextReservation = validReservations
        .map(r => ({
          ...r,
          scheduledTime: typeof r.scheduledTime === 'number' ? r.scheduledTime : parseInt(r.scheduledTime, 10)
        }))
        .sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
      nextFeedTime = new Date(nextReservation.scheduledTime);
      nextFeedType = `Reservation (${nextReservation.user || 'Unknown'})`;
    } else if (lastFeedTime) {
      const cooldownEndTime = lastFeedTime.getTime() + cooldownMs;
      nextFeedTime = new Date(cooldownEndTime + autoFeedDelayMs);
    }
    
    // Calculate time remaining
    const remainingMs = nextFeedTime ? Math.max(0, nextFeedTime.getTime() - now) : 0;
    const remainingHours = Math.floor(remainingMs / 3600000);
    const remainingMinutes = Math.floor((remainingMs % 3600000) / 60000);
    let timeRemaining = 'Ready now';
    if (remainingMs > 0) {
      if (remainingHours > 0) {
        timeRemaining = `${remainingHours}h ${remainingMinutes}m`;
      } else {
        timeRemaining = `${remainingMinutes}m`;
      }
    }
    
    // Format uptime
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMins = Math.floor((uptime % 3600) / 60);
    const uptimeStr = uptimeHours > 0 
      ? `${uptimeHours}h ${uptimeMins}m`
      : `${uptimeMins}m`;

    const message = [
      '📊 <b>SYSTEM STATUS</b>',
      '',
      '<b>🔌 Device Status:</b>',
      `   ${isOnline ? '🟢' : '🔴'} <b>Status:</b> <code>${deviceStatus.toUpperCase()}</code>`,
      `   📶 <b>WiFi:</b> <code>${wifiStatus}</code>`,
      `   ⚙️ <b>Servo:</b> <code>${servoStatus}</code>`,
      `   ⏱️ <b>Uptime:</b> <code>${uptimeStr}</code>`,
      '',
      '<b>🍽️ Feed Status:</b>',
      `   🕐 <b>Last Feed:</b> <code>${formatDate(lastFeedTime)}</code>`,
      `   ⏰ <b>Next Feed:</b> <code>${formatDate(nextFeedTime)}</code>`,
      `   🔧 <b>Type:</b> <code>${nextFeedType}</code>`,
      `   ⏳ <b>Time Remaining:</b> <code>${timeRemaining}</code>`,
      `   ⏱️ <b>Cooldown:</b> <code>${cooldownStr}</code>`,
      '',
      '<b>🌡️ Sensors:</b>',
      `   🌡️ <b>Temperature:</b> <code>${sensors.temperature || 'N/A'}°C</code>`,
      `   💧 <b>TDS:</b> <code>${sensors.tds || 'N/A'} ppm</code>`,
      '',
      '<b>📌 Reservations:</b>',
      `   📋 <b>Count:</b> <code>${validReservations.length}</code>`,
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
      const timestamp = typeof entry.timestamp === 'string' 
        ? parseInt(entry.timestamp, 10) 
        : entry.timestamp;
      const date = timestamp ? new Date(timestamp) : new Date();
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
      return [
        '📌 <b>ACTIVE RESERVATIONS</b>',
        '',
        'No active reservations in queue.',
        '',
        '💡 Use the frontend to create a reservation.',
      ].join('\n');
    }

    const now = Date.now();
    const lines = [
      '📌 <b>ACTIVE RESERVATIONS</b>',
      '',
      `Total: <code>${validReservations.length}</code> reservation(s)`,
      '',
    ];

    validReservations.forEach((reservation, index) => {
      const scheduledTime = typeof reservation.scheduledTime === 'number' 
        ? reservation.scheduledTime 
        : parseInt(reservation.scheduledTime, 10);
      const scheduledDate = scheduledTime ? new Date(scheduledTime) : null;
      const timeStr = formatDate(scheduledDate);
      const user = reservation.user || 'unknown';
      
      // Calculate time remaining
      const remainingMs = Math.max(0, scheduledTime - now);
      const remainingHours = Math.floor(remainingMs / 3600000);
      const remainingMinutes = Math.floor((remainingMs % 3600000) / 60000);
      
      let timeLeft = '⏰ Ready now';
      if (remainingMs > 0) {
        if (remainingHours > 0) {
          timeLeft = `⏳ ${remainingHours}h ${remainingMinutes}m`;
        } else {
          timeLeft = `⏳ ${remainingMinutes}m`;
        }
      }
      
      lines.push(
        `${index + 1}. <b>${user}</b>`,
        `   🕐 ${timeStr}`,
        `   ${timeLeft}`,
        ''
      );
    });

    return lines.join('\n');
  } catch (error) {
    console.error('[TELEGRAM] Error handling /reservations:', error);
    return '❌ Error: Failed to get reservations.';
  }
}

/**
 * Handle /nextfeed command - show when next feed will happen
 */
async function handleNextFeedCommand(db) {
  try {
    const feederRef = db.ref('system/feeder');
    const feederSnapshot = await feederRef.once('value');
    const feederData = feederSnapshot.val() || {};
    
    const lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = timerHour * 3600000 + timerMinute * 60000;
    const autoFeedDelayMinutes = feederData.priority?.autoFeedDelayMinutes !== undefined 
      ? feederData.priority.autoFeedDelayMinutes 
      : 30;
    const autoFeedDelayMs = autoFeedDelayMinutes * 60000;
    
    const reservations = feederData.reservations || [];
    const validReservations = reservations.filter((r) => r && r.scheduledTime);
    
    const now = Date.now();
    let nextFeedTime = null;
    let nextFeedType = 'Auto Feed';
    
    // Check if there's a reservation ready or upcoming
    if (validReservations.length > 0) {
      const nextReservation = validReservations
        .map(r => ({
          ...r,
          scheduledTime: typeof r.scheduledTime === 'number' ? r.scheduledTime : parseInt(r.scheduledTime, 10)
        }))
        .sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
      
      nextFeedTime = nextReservation.scheduledTime;
      nextFeedType = `Reservation (${nextReservation.user || 'Unknown'})`;
    } else {
      // Calculate auto feed time
      if (lastFeedTime > 0) {
        const cooldownEndTime = lastFeedTime + cooldownMs;
        nextFeedTime = cooldownEndTime + autoFeedDelayMs;
      } else {
        nextFeedTime = now;
      }
    }
    
    const remainingMs = Math.max(0, nextFeedTime - now);
    const remainingHours = Math.floor(remainingMs / 3600000);
    const remainingMinutes = Math.floor((remainingMs % 3600000) / 60000);
    const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
    
    let timeRemaining = 'Ready now';
    if (remainingMs > 0) {
      if (remainingHours > 0) {
        timeRemaining = `${remainingHours}h ${remainingMinutes}m`;
      } else if (remainingMinutes > 0) {
        timeRemaining = `${remainingMinutes}m ${remainingSeconds}s`;
      } else {
        timeRemaining = `${remainingSeconds}s`;
      }
    }
    
    const nextFeedDate = nextFeedTime ? new Date(nextFeedTime) : null;
    
    return [
      '⏰ <b>NEXT FEED</b>',
      '',
      `🔧 <b>Type:</b> <code>${nextFeedType}</code>`,
      `🕐 <b>Scheduled:</b> <code>${formatDate(nextFeedDate)}</code>`,
      `⏳ <b>Time Remaining:</b> <code>${timeRemaining}</code>`,
      '',
      validReservations.length > 0 
        ? `📌 <b>Reservations:</b> <code>${validReservations.length}</code> in queue`
        : '🤖 Auto feed will trigger after cooldown + delay',
    ].join('\n');
  } catch (error) {
    console.error('[TELEGRAM] Error handling /nextfeed:', error);
    return '❌ Error: Failed to get next feed time.';
  }
}

/**
 * Handle /cooldown command - show cooldown status
 */
async function handleCooldownCommand(db) {
  try {
    const feederRef = db.ref('system/feeder');
    const feederSnapshot = await feederRef.once('value');
    const feederData = feederSnapshot.val() || {};
    
    const lastFeedTime = feederData.lastFeedTime || 0;
    const timerHour = feederData.timer?.hour || 0;
    const timerMinute = feederData.timer?.minute || 0;
    const cooldownMs = timerHour * 3600000 + timerMinute * 60000;
    
    const now = Date.now();
    const cooldownEndsAt = lastFeedTime + cooldownMs;
    const remainingMs = Math.max(0, cooldownEndsAt - now);
    
    const cooldownHours = Math.floor(cooldownMs / 3600000);
    const cooldownMins = Math.floor((cooldownMs % 3600000) / 60000);
    const cooldownStr = `${cooldownHours}:${cooldownMins.toString().padStart(2, '0')}`;
    
    const remainingHours = Math.floor(remainingMs / 3600000);
    const remainingMinutes = Math.floor((remainingMs % 3600000) / 60000);
    const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);
    
    let remainingStr = '✅ Cooldown finished';
    if (remainingMs > 0) {
      if (remainingHours > 0) {
        remainingStr = `${remainingHours}h ${remainingMinutes}m ${remainingSeconds}s`;
      } else if (remainingMinutes > 0) {
        remainingStr = `${remainingMinutes}m ${remainingSeconds}s`;
      } else {
        remainingStr = `${remainingSeconds}s`;
      }
    }
    
    return [
      '⏳ <b>COOLDOWN STATUS</b>',
      '',
      `⏱️ <b>Cooldown Period:</b> <code>${cooldownStr}</code>`,
      `⏰ <b>Last Feed:</b> <code>${formatDate(lastFeedTime ? new Date(lastFeedTime) : null)}</code>`,
      `🕐 <b>Cooldown Ends:</b> <code>${formatDate(new Date(cooldownEndsAt))}</code>`,
      '',
      remainingMs > 0 
        ? `⏳ <b>Time Remaining:</b> <code>${remainingStr}</code>`
        : `✅ <b>Status:</b> <code>${remainingStr}</code>`,
    ].join('\n');
  } catch (error) {
    console.error('[TELEGRAM] Error handling /cooldown:', error);
    return '❌ Error: Failed to get cooldown status.';
  }
}

/**
 * Handle /help command.
 */
function handleHelpCommand() {
  return [
    '🤖 <b>FishFeeder Bot Commands</b>',
    '',
    '📊 <b>Information:</b>',
    '  /status – Full system status',
    '  /nextfeed – When next feed will happen',
    '  /cooldown – Cooldown status and time remaining',
    '  /reservations – Active reservation queue with time left',
    '  /history – Last 5 feed events',
    '',
    '🔧 <b>Actions:</b>',
    '  /clear – Clear all bot messages',
    '  /help – Show this help message',
  ].join('\n');
}

/**
 * Handle Telegram webhook POST requests.
 */
export async function POST(request) {
  // Handle CORS preflight
  const corsResponse = handleCORS(request);
  if (corsResponse) return corsResponse;

  try {
    const body = await request.json();

    // Check if it's a message update
    if (!body.message || !body.message.text) {
      const response = NextResponse.json({ ok: true });
      return addCorsHeaders(response);
    }

    const messageText = body.message.text.trim();
    const chatId = body.message.chat.id;

    // Verify chat ID matches configured chat ID
    const configuredChatId = process.env.TELEGRAM_CHAT_ID;
    if (String(chatId) !== String(configuredChatId)) {
      console.warn(`[TELEGRAM] Received message from unauthorized chat: ${chatId}`);
      const response = NextResponse.json({ ok: true });
      return addCorsHeaders(response);
    }

    let db;
    try {
      db = getDatabase();
    } catch (error) {
      console.error('[TELEGRAM] Firebase initialization failed:', error);
      await sendSimpleTelegramMessage('❌ Error: Failed to initialize database.');
      const response = NextResponse.json({ ok: true });
      return addCorsHeaders(response);
    }

    let responseMessage = '';

    // Handle commands
    if (messageText === '/status') {
      responseMessage = await handleStatusCommand(db);
    } else if (messageText === '/nextfeed' || messageText === '/next') {
      responseMessage = await handleNextFeedCommand(db);
    } else if (messageText === '/cooldown') {
      responseMessage = await handleCooldownCommand(db);
    } else if (messageText === '/history') {
      responseMessage = await handleHistoryCommand(db);
    } else if (messageText === '/reservations' || messageText === '/res') {
      responseMessage = await handleReservationsCommand(db);
    } else if (messageText === '/help' || messageText === '/start') {
      responseMessage = handleHelpCommand();
    } else if (messageText === '/clear') {
      const result = await clearAllTelegramMessages(db);
      if (result.success) {
        responseMessage = `✅ <b>Chat Cleared</b>\n🗑️ Deleted <code>${result.deleted}</code> message(s).`;
      } else {
        responseMessage = `❌ Error: ${result.error}`;
      }
    } else {
      // Unknown command - show help
      responseMessage = '❓ Unknown command. Use /help to see available commands.';
    }

    if (responseMessage) {
      await sendSimpleTelegramMessage(responseMessage);
    }

    const response = NextResponse.json({ ok: true });
    return addCorsHeaders(response);
  } catch (error) {
    console.error('[TELEGRAM] Webhook error:', error);
    const response = NextResponse.json({ ok: true });
    return addCorsHeaders(response);
  }
}

/**
 * Handle GET requests (for webhook verification).
 */
export async function GET() {
  const response = NextResponse.json({
    message: 'Telegram webhook endpoint. Use POST to send updates.',
  });
  return addCorsHeaders(response);
}

/**
 * Handle OPTIONS for CORS
 */
export async function OPTIONS(request) {
  return handleCORS(request);
}
