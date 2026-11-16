// Android/iOS yerel bildirimleri. Ekranın açılışında native modüle dokunulmaz.
// İzin yoksa / modül yüklenmemişse rezervasyonlar ve uygulama normal çalışır;
// kırmızı satır ve uygulama içi uyarı her durumda korunur.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { clockExpiryDate } from './clockLogic';

const TRACKING_KEY = 'reserva-plus:clock-notifications:v1';
const CHANNEL_ID = 'saatli-masa-gecikme';
let queue = Promise.resolve();
let notifications = null;
let prepared = false;

function enqueue(task) {
  const next = queue.catch(() => {}).then(task);
  queue = next.catch(() => {});
  return next;
}
function loadModule() {
  if (Platform.OS === 'web') return null;
  if (!notifications) {
    try { notifications = require('expo-notifications'); }
    catch (error) { console.warn('Yerel bildirim modülü kullanılamıyor:', error?.message || error); return null; }
  }
  return notifications;
}
async function prepareModule() {
  const n = loadModule();
  if (!n) return null;
  if (!prepared) {
    n.setNotificationHandler({ handleNotification: async () => ({
      shouldShowBanner: true, shouldShowList: true,
      shouldPlaySound: true, shouldSetBadge: false,
    }) });
    if (Platform.OS === 'android') {
      await n.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Saatli Masa Gecikmeleri',
        importance: n.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 200, 250],
        lightColor: '#F04438',
      });
    }
    prepared = true;
  }
  return n;
}
async function readMap() {
  try { return JSON.parse((await AsyncStorage.getItem(TRACKING_KEY)) || '{}'); }
  catch { return {}; }
}
async function writeMap(map) { await AsyncStorage.setItem(TRACKING_KEY, JSON.stringify(map)); }

export function scheduleClockAlert(reservation, options = {}) {
  return enqueue(async () => {
    try {
      const n = await prepareModule();
      if (!n || !reservation?.id) return false;
      const current = await readMap();
      const previous = current[reservation.id];
      const expiry = clockExpiryDate(reservation);
      const targetMs = expiry?.getTime();
      if (previous?.notificationId && previous.when === targetMs && reservation.status !== 'cancelled') return true;
      if (previous?.notificationId) await n.cancelScheduledNotificationAsync(previous.notificationId).catch(() => {});
      delete current[reservation.id];
      if (!expiry || targetMs <= Date.now() || reservation.status === 'cancelled') {
        await writeMap(current); return false;
      }
      let permission = await n.getPermissionsAsync();
      if (!permission.granted && options.askPermission !== false && permission.canAskAgain !== false) {
        permission = await n.requestPermissionsAsync();
      }
      if (!permission.granted) { await writeMap(current); return false; }
      const notificationId = await n.scheduleNotificationAsync({
        content: {
          title: 'Saatli Masa Gecikti',
          body: `${reservation.tableNumber ? `Masa ${reservation.tableNumber}` : 'Saatli masa'} için kalkış saati doldu.`,
          sound: 'default',
          data: { reservaPlusClockId: reservation.id, areaId: reservation.areaId },
        },
        trigger: {
          type: n.SchedulableTriggerInputTypes.DATE,
          date: expiry,
          ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
        },
      });
      current[reservation.id] = { notificationId, when: targetMs, areaId: reservation.areaId };
      await writeMap(current);
      return true;
    } catch (error) {
      console.warn('Saatli Masa bildirimi ayarlanamadı:', error?.message || error);
      return false;
    }
  });
}

export function cancelClockAlert(reservationId) {
  return enqueue(async () => {
    try {
      if (!reservationId) return;
      const n = loadModule();
      const current = await readMap();
      const previous = current[reservationId];
      if (previous?.notificationId && n) await n.cancelScheduledNotificationAsync(previous.notificationId).catch(() => {});
      if (previous) { delete current[reservationId]; await writeMap(current); }
    } catch (error) { console.warn('Saatli Masa bildirimi kaldırılamadı:', error?.message || error); }
  });
}

export function cancelClockAlertsForArea(areaId) {
  return enqueue(async () => {
    try {
      const n = loadModule();
      const current = await readMap();
      let changed = false;
      for (const [reservationId, item] of Object.entries(current)) {
        if (item?.areaId !== areaId) continue;
        if (item.notificationId && n) await n.cancelScheduledNotificationAsync(item.notificationId).catch(() => {});
        delete current[reservationId]; changed = true;
      }
      if (changed) await writeMap(current);
    } catch (error) { console.warn('Saatli Masa alan bildirimleri kaldırılamadı:', error?.message || error); }
  });
}
