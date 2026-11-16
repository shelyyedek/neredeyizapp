import AsyncStorage from '@react-native-async-storage/async-storage';

// Local, date-partitioned storage. One small JSON document per reservation day,
// and a tiny index for the management screen. No native database module.
// Legacy snapshots are kept untouched as a one-time migration safety backup.
const META = 'reserva-plus:local:meta:v1';
const INDEX = 'reserva-plus:local:dates:v1';
const DAY = 'reserva-plus:local:day:v1:';
const LEGACY = 'reservation-plus:v1';
const RECOVERY = 'reserva-plus:recovery:v1';
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
let readyPromise = null;
let queue = Promise.resolve();
const queueOperation = (fn) => {
  const result = queue.catch(() => {}).then(fn);
  queue = result;
  return result;
};
const parse = (raw, label) => {
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`${label} okunamadı; eski veriler silinmedi: ${e?.message || e}`); }
};
const dayKey = (date) => DAY + date;
const isValidDate = (date) => VALID_DATE.test(String(date));

async function initialize({ storageKey = LEGACY, normalize, fallback }) {
  const existingMeta = await AsyncStorage.getItem(META);
  if (existingMeta) {
    const state = parse(existingMeta, 'Uygulama ayarları');
    if (!Array.isArray(state.areas) || !Array.isArray(state.tables)) {
      throw new Error('Yerel kayıt başlığı eksik. Güvenlik için işlem durduruldu.');
    }
    if (!(await AsyncStorage.getItem(INDEX))) {
      throw new Error('Rezervasyon tarih dizini bulunamadı. Eski yedekler korunuyor.');
    }
    return;
  }
  // Existing v1.7.x recovery snapshot takes priority over the original backup.
  const latest = await AsyncStorage.getItem(RECOVERY);
  const original = latest === null ? await AsyncStorage.getItem(storageKey) : null;
  const raw = latest ?? original;
  const source = raw === null ? fallback() : parse(raw, 'Eski rezervasyon yedeği');
  if (!source || !Array.isArray(source.areas) || !Array.isArray(source.tables) || !Array.isArray(source.reservations)) {
    throw new Error('Eski kayıt biçimi anlaşılamadı; orijinal yedeklere dokunulmadı.');
  }
  const state = normalize(source);
  const grouped = {};
  for (const item of state.reservations) {
    if (!isValidDate(item.date)) throw new Error('Tarihi okunamayan bir rezervasyon var. Kayıt kaybını önlemek için aktarım durduruldu.');
    if (!grouped[item.date]) grouped[item.date] = [];
    grouped[item.date].push(item);
  }
  const index = {};
  // Write all day records first. META is the final successful-migration marker.
  // If power fails mid-migration the next opening safely retries from backups.
  for (const [date, records] of Object.entries(grouped)) {
    await AsyncStorage.setItem(dayKey(date), JSON.stringify(records));
    index[date] = records.length;
  }
  await AsyncStorage.setItem(INDEX, JSON.stringify(index));
  await AsyncStorage.setItem(META, JSON.stringify({
    areas: state.areas, categories: state.categories || [],
    tables: state.tables, settings: state.settings || {},
  }));
}

function ensureReady(args) {
  if (!readyPromise) readyPromise = initialize(args).catch((error) => { readyPromise = null; throw error; });
  return readyPromise;
}

const readIndex = async () => parse((await AsyncStorage.getItem(INDEX)) || '{}', 'Tarih dizini');
const readDay = async (date) => {
  const raw = await AsyncStorage.getItem(dayKey(date));
  const value = raw === null ? [] : parse(raw, `${date} rezervasyonları`);
  if (!Array.isArray(value)) throw new Error(`${date} rezervasyon kaydı hasarlı; kayıt korunuyor.`);
  return value;
};

export async function loadAppState({ storageKey, normalize, fallback, dateKey }) {
  await ensureReady({ storageKey, normalize, fallback });
  const meta = parse(await AsyncStorage.getItem(META), 'Uygulama ayarları');
  const reservations = await readDay(dateKey);
  return normalize({ ...meta, reservations });
}

export async function loadDateReservations(date) {
  if (!readyPromise) throw new Error('Yerel kayıtlar henüz hazırlanmadı.');
  await readyPromise;
  await queue.catch(() => {});
  return readDay(date);
}

// Only dates which actually have reservations, and strictly before today.
export async function listReservationHistoryDates(today) {
  await readyPromise;
  await queue.catch(() => {});
  const index = await readIndex();
  return Object.entries(index)
    .filter(([date, count]) => isValidDate(date) && date < today && Number(count) > 0)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, count]) => ({ date, count: Number(count) }));
}

export async function deleteReservationHistoryDates(dates, today) {
  await readyPromise;
  const selected = [...new Set(dates)].filter((date) => isValidDate(date) && date < today);
  return queueOperation(async () => {
    const index = await readIndex();
    const matched = selected.filter((date) => Number(index[date]) > 0);
    // A confirmed deletion also removes those dates from historical snapshots.
    // Otherwise downgrading/restoring an older build could resurrect old days,
    // and the large legacy JSON would still occupy disk space.
    if (matched.length) {
      const matchedSet = new Set(matched);
      for (const legacyKey of [RECOVERY, LEGACY]) {
        const raw = await AsyncStorage.getItem(legacyKey);
        if (raw === null) continue;
        const snapshot = parse(raw, 'Eski arşiv');
        if (!snapshot || !Array.isArray(snapshot.reservations)) {
          throw new Error('Eski arşiv anlaşılamadı; güvenlik için silme durduruldu.');
        }
        const kept = snapshot.reservations.filter((r) => !matchedSet.has(r.date));
        if (kept.length !== snapshot.reservations.length) {
          await AsyncStorage.setItem(legacyKey, JSON.stringify({ ...snapshot, reservations: kept }));
        }
      }
    }
    let deletedDays = 0;
    let deletedReservations = 0;
    for (const date of selected) {
      if (!Number(index[date])) continue;
      // Remove day's document before removing the index entry, so interrupted
      // deletion never reconstructs the day from an older backup.
      await AsyncStorage.removeItem(dayKey(date));
      deletedDays += 1;
      deletedReservations += Number(index[date]);
      delete index[date];
      await AsyncStorage.setItem(INDEX, JSON.stringify(index));
    }
    return { deletedDays, deletedReservations };
  });
}

const tableIdKey = (t) => `${t.areaId}::${String(t.number).trim().toLocaleLowerCase('tr-TR')}`;

export function persistAppState(previous, next, dateKey) {
  return queueOperation(async () => {
    await readyPromise;
    if (!isValidDate(dateKey)) throw new Error('Kayıt tarihi geçersiz.');
    const current = next.reservations || [];
    if (current.some((r) => r.date !== dateKey)) throw new Error('Yanlış güne rezervasyon kaydı engellendi.');
    const previousDay = previous?.reservations || [];
    const meta = { areas: next.areas, categories: next.categories || [], tables: next.tables, settings: next.settings || {} };
    // Most edits change only today's reservations OR a single setting/note.
    // Do not deserialize and rewrite the date index for an unrelated change.
    const previousTables = previous?.tables || [];
    const nextTables = next.tables || [];
    const tablesChanged = nextTables !== previousTables;
    const nextAreaIds = new Set((next.areas || []).map((a) => a.id));
    const areaRemoved = (previous?.areas || []).some((a) => !nextAreaIds.has(a.id));
    const tableChanges = new Map();
    const removedTables = new Set();
    if (tablesChanged) {
      const beforeTables = new Map(previousTables.map((t) => [t.id, t]));
      const afterTables = new Map(nextTables.map((t) => [t.id, t]));
      for (const [id, old] of beforeTables) {
        const newer = afterTables.get(id);
        if (!newer) removedTables.add(tableIdKey(old));
        else if (newer.areaId !== old.areaId || String(newer.number) !== String(old.number)) {
          tableChanges.set(tableIdKey(old), newer);
        }
      }
    }
    const structuralChanges = removedTables.size > 0 || tableChanges.size > 0 || areaRemoved;
    const recordsChanged = current !== previousDay && JSON.stringify(current) !== JSON.stringify(previousDay);
    let index = null;
    let indexDirty = false;
    if (structuralChanges || recordsChanged) index = await readIndex();
    if (structuralChanges) {
      const allowedAreas = new Set((next.areas || []).map((area) => area.id));
      for (const day of Object.keys(index)) {
        if (day === dateKey) continue;
        const oldRecords = await readDay(day);
        const records = oldRecords.flatMap((r) => {
          if (!allowedAreas.has(r.areaId)) return [];
          const key = `${r.areaId}::${String(r.tableNumber).trim().toLocaleLowerCase('tr-TR')}`;
          if (removedTables.has(key)) return [];
          const moved = tableChanges.get(key);
          return moved ? [{ ...r, areaId: moved.areaId, tableNumber: String(moved.number) }] : [r];
        });
        if (JSON.stringify(records) !== JSON.stringify(oldRecords)) {
          if (records.length) await AsyncStorage.setItem(dayKey(day), JSON.stringify(records));
          else await AsyncStorage.removeItem(dayKey(day));
          if (records.length) index[day] = records.length;
          else delete index[day];
          indexDirty = true;
        }
      }
    }
    if (recordsChanged) {
      if (current.length) await AsyncStorage.setItem(dayKey(dateKey), JSON.stringify(current));
      else await AsyncStorage.removeItem(dayKey(dateKey));
      if (current.length !== (Number(index[dateKey]) || 0)) {
        if (current.length) index[dateKey] = current.length;
        else delete index[dateKey];
        indexDirty = true;
      }
    }
    if (indexDirty) await AsyncStorage.setItem(INDEX, JSON.stringify(index));
    const metaHasChanged = !previous ||
      (next.areas !== previous.areas && JSON.stringify(next.areas) !== JSON.stringify(previous.areas)) ||
      (next.categories !== previous.categories && JSON.stringify(next.categories || []) !== JSON.stringify(previous.categories || [])) ||
      (next.tables !== previous.tables && JSON.stringify(next.tables) !== JSON.stringify(previous.tables)) ||
      (next.settings !== previous.settings && JSON.stringify(next.settings || {}) !== JSON.stringify(previous.settings || {}));
    if (metaHasChanged) await AsyncStorage.setItem(META, JSON.stringify(meta));
  });
}


// Yalnızca bizim ürettiğimiz ve hem bayrağı hem özel ID öneki olan test
// rezervasyonları silinir. Gerçek rezervasyonlara dokunulmaz.
const isTestReservation = (r) => r?.testData === true && String(r?.id || '').startsWith('test_reserva_');

export async function deleteAllTestReservations() {
  if (!readyPromise) throw new Error('Yerel kayıtlar henüz hazır değil.');
  await readyPromise;
  return queueOperation(async () => {
    const index = await readIndex();
    let deletedReservations = 0;
    let affectedDays = 0;
    for (const date of Object.keys(index)) {
      if (!isValidDate(date)) continue;
      const existing = await readDay(date);
      const remaining = existing.filter((r) => !isTestReservation(r));
      const removed = existing.length - remaining.length;
      if (!removed) continue;
      // Her gün kendi başına yazılır; arada kesinti olursa diğer günler ve
      // gerçek rezervasyonlar korunur. Tekrar çalıştırmak güvenlidir.
      if (remaining.length) {
        await AsyncStorage.setItem(dayKey(date), JSON.stringify(remaining));
        index[date] = remaining.length;
      } else {
        await AsyncStorage.removeItem(dayKey(date));
        delete index[date];
      }
      await AsyncStorage.setItem(INDEX, JSON.stringify(index));
      deletedReservations += removed;
      affectedDays += 1;
    }
    return { deletedReservations, affectedDays };
  });
}
