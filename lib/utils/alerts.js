/**
 * Alert utilities for sensors and device status
 */
import { sendTelegram, formatDate } from '../services/telegram.js';
import { isDeviceOnline, sendDeviceOfflineMessage } from './feeder.js';

/**
 * Check and send sensor alerts with throttling
 */
export async function checkSensorAlerts({ db, sensors, alertsRef, now }) {
  if (!alertsRef) return;

  const alertsSnapshot = await alertsRef.once('value');
  const alerts = alertsSnapshot.val() || {};
  const thirtyMinutesAgo = now.getTime() - 30 * 60 * 1000;

  // Check TDS
  if (sensors?.tds && sensors.tds > 800) {
    const lastTdsAlert = alerts.lastTdsAlert || 0;
    if (lastTdsAlert < thirtyMinutesAgo) {
      await sendTelegram(
        [
          '⚠️ <b>WATER QUALITY WARNING</b>',
          '',
          `💧 <b>TDS Level:</b> <code>${sensors.tds} ppm</code>`,
          `📊 <b>Normal Range:</b> <code>200–600 ppm</code>`,
          `🔴 <b>Status:</b> <code>HIGH</code>`,
          '',
          `⏰ <b>Time:</b> <code>${formatDate(now)}</code>`,
          '',
          '💡 Consider water change or filtration.',
        ].join('\n'),
        db
      );
      await alertsRef.child('lastTdsAlert').set(now.getTime());
    }
  }

  // Check Temperature
  if (sensors?.temperature) {
    const temp = sensors.temperature;
    if (temp < 20 || temp > 30) {
      const lastTempAlert = alerts.lastTempAlert || 0;
      if (lastTempAlert < thirtyMinutesAgo) {
        const status = temp < 20 ? 'LOW' : 'HIGH';
        const emoji = temp < 20 ? '❄️' : '🔥';
        await sendTelegram(
          [
            `${emoji} <b>TEMPERATURE WARNING</b>`,
            '',
            `🌡️ <b>Current:</b> <code>${temp}°C</code>`,
            `📊 <b>Safe Range:</b> <code>20–30°C</code>`,
            `🔴 <b>Status:</b> <code>${status}</code>`,
            '',
            `⏰ <b>Time:</b> <code>${formatDate(now)}</code>`,
            '',
            temp < 20 
              ? '💡 Consider using a heater.'
              : '💡 Consider cooling or shade.',
          ].join('\n'),
          db
        );
        await alertsRef.child('lastTempAlert').set(now.getTime());
      }
    }
  }
}

/**
 * Check and send device online/offline alerts with throttling
 */
export async function checkDeviceAlerts({ db, deviceData, alertsRef, now, wasOnline }) {
  if (!alertsRef) return false;

  const alertsSnapshot = await alertsRef.once('value');
  const alerts = alertsSnapshot.val() || {};
  const fifteenMinutesAgo = now.getTime() - 15 * 60 * 1000;

  const lastSeen = deviceData?.lastSeen;
  const isOnline = isDeviceOnline(lastSeen, deviceData);

  // Device went offline
  if (wasOnline && !isOnline) {
    const lastOfflineAlert = alerts.lastOfflineAlert || 0;
    if (lastOfflineAlert < fifteenMinutesAgo) {
      await sendDeviceOfflineMessage({ lastSeen, db });
      await alertsRef.child('lastOfflineAlert').set(now.getTime());
    }
  }

  // Device came online
  if (!wasOnline && isOnline) {
    const lastOnlineAlert = alerts.lastOnlineAlert || 0;
    if (lastOnlineAlert < fifteenMinutesAgo) {
      const uptime = deviceData?.uptime || 0;
      const uptimeHours = Math.floor(uptime / 3600);
      const uptimeMins = Math.floor((uptime % 3600) / 60);
      const uptimeStr = uptimeHours > 0 
        ? `${uptimeHours}h ${uptimeMins}m`
        : `${uptimeMins}m`;
      
      await sendTelegram(
        [
          '🟢 <b>DEVICE ONLINE</b>',
          '',
          '✅ Connection restored successfully.',
          '',
          '<b>📡 Connection Info:</b>',
          `   📶 <b>WiFi:</b> <code>${deviceData?.wifi || 'unknown'}</code>`,
          `   ⏱️ <b>Uptime:</b> <code>${uptimeStr}</code>`,
          `   🕐 <b>Last Sync:</b> <code>${formatDate(now)}</code>`,
          '',
          '✨ System is operational.',
        ].join('\n'),
        db
      );
      await alertsRef.child('lastOnlineAlert').set(now.getTime());
    }
  }

  return isOnline;
}

