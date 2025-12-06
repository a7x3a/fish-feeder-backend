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
          '⚠️ <b>WATER WARNING</b>',
          `TDS is high: <code>${sensors.tds} ppm</code>`,
          'Normal: 200–600 ppm',
          `⏰ ${formatDate(now)}`,
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
        await sendTelegram(
          [
            '⚠️ <b>TEMPERATURE WARNING</b>',
            `Current: <code>${temp}°C</code>`,
            'Safe Range: 20–30°C',
            `⏰ ${formatDate(now)}`,
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
      await sendTelegram(
        [
          '🟢 <b>DEVICE ONLINE</b>',
          'Connection restored.',
          '',
          `WiFi: <code>${deviceData?.wifi || 'unknown'}</code>`,
          `Uptime: <code>${deviceData?.uptime || 0} seconds</code>`,
          `Last Sync: <code>${formatDate(now)}</code>`,
        ].join('\n'),
        db
      );
      await alertsRef.child('lastOnlineAlert').set(now.getTime());
    }
  }

  return isOnline;
}

