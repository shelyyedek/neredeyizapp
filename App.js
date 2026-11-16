import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
  AppState,
  Modal,
  Platform,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { loadAppState, loadDateReservations, persistAppState, listReservationHistoryDates, deleteReservationHistoryDates, deleteAllTestReservations } from './storage';
import { isClockReservationLate } from './clockLogic';
import { scheduleClockAlert, cancelClockAlert, cancelClockAlertsForArea } from './clockNotifications';

const STORAGE_KEY = 'reservation-plus:v1';
const OPTIONAL_AREA_ID = '__reserva_optional_quick_panels__';
const QUICK_CLOCK_AREA_ID = '__reserva_quick_clock__';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'aliercanqc06';

const COLORS = {
  bg: '#F4F7FB',
  card: '#FFFFFF',
  text: '#101828',
  muted: '#667085',
  line: '#E4E7EC',
  blue: '#2563EB',
  blueSoft: '#EFF6FF',
  blueBorder: '#B2CCFF',
  blueStrongBorder: '#84ADFF',
  green: '#12B76A',
  greenSoft: '#ECFDF3',
  orange: '#F79009',
  orangeSoft: '#FFF4E5',
  yellow: '#EAB308',
  yellowSoft: '#FFFBE6',
  red: '#F04438',
  redSoft: '#FEF3F2',
  purple: '#7F56D9',
  purpleSoft: '#F4F3FF',
  star: '#F59E0B',
  starSoft: '#FFF7D6',
};

const STATUS = {
  approved: { label: 'Onaylı', color: COLORS.green, bg: '#F2F4F7' },
  arrived: { label: 'Geldi', color: '#2563EB', bg: '#EFF6FF' },
  cancelled: { label: 'İptal', color: COLORS.red, bg: COLORS.redSoft },
};

function id(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function normalizedSearch(value) {
  return String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ç/g, 'c')
    .replace(/ö/g, 'o').replace(/ü/g, 'u');
}

function normalizeCapacityRanges(settings) {
  const source = Array.isArray(settings?.capacityFilterRanges) && settings.capacityFilterRanges.length
    ? settings.capacityFilterRanges
    : (Array.isArray(settings?.capacityFilterValues) ? settings.capacityFilterValues : [2, 4, 6]);
  const unique = new Set();
  return source.map((item) => {
    const first = Number(typeof item === 'object' && item !== null ? item.min : item);
    const last = Number(typeof item === 'object' && item !== null ? item.max : item);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 99 || first > last) return null;
    const key = `${first}-${last}`;
    if (unique.has(key)) return null;
    unique.add(key);
    return { min: first, max: last };
  }).filter(Boolean).slice(0, 10);
}
function formatCapacityRange(range) {
  return range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
}
function capacityRangeLabel(range) {
  return range.min === range.max ? `${range.min} kişilik` : `${range.min}–${range.max} kişilik`;
}
function parseCapacityRanges(input) {
  const parts = String(input).split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean);
  if (!parts.length || parts.length > 10) return null;
  const ranges = parts.map((part) => {
    const match = part.match(/^(\d{1,2})\s*[-–]\s*(\d{1,2})$|^(\d{1,2})$/);
    if (!match) return null;
    const min = Number(match[1] ?? match[3]);
    const max = Number(match[2] ?? match[3]);
    if (min < 1 || max > 99 || min > max) return null;
    return { min, max };
  });
  if (ranges.some((r) => !r)) return null;
  const unique = new Set(ranges.map(formatCapacityRange));
  return unique.size === ranges.length ? ranges : null;
}
function noteForDay(table, dateKey) {
  return String(table?.notesByDate?.[dateKey] || '').trim();
}
function withDayNote(table, dateKey, note) {
  const notesByDate = { ...(table.notesByDate || {}) };
  if (note) notesByDate[dateKey] = note;
  else delete notesByDate[dateKey];
  return { ...table, notesByDate };
}

function tableKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase('tr-TR');
}

function tableLabel(value, withPrefix = false) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  if (withPrefix && /^\d+$/.test(text)) return `Masa ${text}`;
  return text;
}

// Girilen saati 19:30, 19.30, 19-30 veya 1930 olarak kabul et.
// Tutarlı sıralama/filtreleme için kaydederken HH:MM biçimine dönüştür.
function parseReservationTime(value) {
  const raw = String(value ?? '').trim();
  let hour;
  let minute;
  if (/^\d{3,4}$/.test(raw)) {
    const padded = raw.padStart(4, '0');
    hour = Number(padded.slice(0, 2));
    minute = Number(padded.slice(2));
  } else {
    const match = raw.match(/^(\d{1,2})[:.\-](\d{1,2})$/);
    if (!match) return null;
    hour = Number(match[1]);
    minute = Number(match[2]);
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, minutes: hour * 60 + minute };
}

function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function prettyDate(key) {
  const d = fromDateKey(key);
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

function weekday(key) {
  const d = fromDateKey(key);
  return new Intl.DateTimeFormat('tr-TR', { weekday: 'long' }).format(d);
}

function shiftDate(key, days) {
  const d = fromDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

function isTestReservation(reservation) {
  return reservation?.testData === true && String(reservation?.id || '').startsWith('test_reserva_');
}

function reservationDelayMinutes(reservation, now) {
  if (isTestReservation(reservation)) return -1;
  if (reservation.date !== toDateKey(now)) return -1;
  if (reservation.status !== 'approved') return -1;
  const parsed = parseReservationTime(reservation.time);
  if (!parsed) return -1;
  const reservationTime = fromDateKey(reservation.date);
  reservationTime.setHours(parsed.hour, parsed.minute, 0, 0);
  return Math.floor((now.getTime() - reservationTime.getTime()) / 60000);
}

function reservationMinutesUntil(reservation, now) {
  if (isTestReservation(reservation)) return null;
  if (reservation.date !== toDateKey(now)) return null;
  if (reservation.status === 'arrived' || reservation.status === 'cancelled') return null;
  const parsed = parseReservationTime(reservation.time);
  if (!parsed) return null;

  // Saat dilimi parse sorunlarından kaçınmak için gün içindeki dakika üzerinden
  // hesaplıyoruz. Saniyeyi dahil edip floor kullanmak, örneğin gerçek kalan
  // süre 15 dk 50 sn iken kaydın 15 dk penceresinde görünmesini sağlar.
  const nowMinuteOfDay = (now.getHours() * 60) + now.getMinutes() + (now.getSeconds() / 60);
  return Math.floor(parsed.minutes - nowMinuteOfDay);
}

function quickClockActiveLateCount(settings, now) {
  return (settings?.quickClockEntries || []).filter((entry) =>
    isClockReservationLate({ ...entry, time: entry.endTime, status: 'approved' }, now)).length;
}

function normalizeStoredData(value) {
  const fallback = initialState();
  if (!value || !Array.isArray(value.areas) || !Array.isArray(value.tables) || !Array.isArray(value.reservations)) {
    return fallback;
  }
  const upcomingMinutes = Number(value.settings?.upcomingMinutes);
  const overdueMinutes = Number(value.settings?.overdueMinutes);
  const autoCancelMinutes = Number(value.settings?.autoCancelMinutes);
  const capacityFilterRanges = normalizeCapacityRanges(value.settings);
  return {
    areas: value.areas.map((area) => ({
      ...area,
      clockArea: area.clockArea === true,
      timedArea: area.timedArea === true && area.clockArea !== true,
      defaultStartTime: parseReservationTime(area.defaultStartTime)
        ? `${pad(parseReservationTime(area.defaultStartTime).hour)}:${pad(parseReservationTime(area.defaultStartTime).minute)}` : '',
      defaultEndTime: parseReservationTime(area.defaultEndTime)
        ? `${pad(parseReservationTime(area.defaultEndTime).hour)}:${pad(parseReservationTime(area.defaultEndTime).minute)}` : '',
    })),
    categories: Array.isArray(value.categories) ? value.categories : [],
    tables: value.tables.map((t) => ({
      ...t,
      number: String(t.number ?? '').trim(),
      capacity: Number.isInteger(Number(t.capacity)) && Number(t.capacity) > 0 ? Number(t.capacity) : 4,
      categoryId: t.categoryId || null,
      // Legacy non-dated notes are preserved but never displayed on another day.
      note: String(t.note || ''),
      notesByDate: t.notesByDate && typeof t.notesByDate === 'object' && !Array.isArray(t.notesByDate) ? { ...t.notesByDate } : {},
    })),
    reservations: value.reservations.map((r) => ({
      ...r,
      tableNumber: String(r.tableNumber ?? '').trim(),
      status: r.status === 'pending' ? 'approved' : (STATUS[r.status] ? r.status : 'approved'),
      important: Boolean(r.important),
      note: String(r.note || ''),
      seatedTable: String(r.seatedTable || ''),
      guestArrived: Boolean(r.guestArrived || r.seatedTable),
      endTime: String(r.endTime || ''),
    })),
    settings: {
      upcomingMinutes: Number.isInteger(upcomingMinutes) && upcomingMinutes >= 5 && upcomingMinutes <= 240 ? upcomingMinutes : 30,
      overdueMinutes: value.settings?.delayRulesV2 && Number.isInteger(overdueMinutes) && overdueMinutes >= 0 && overdueMinutes <= 240 ? overdueMinutes : 0,
      autoCancelMinutes: Number.isInteger(autoCancelMinutes) && autoCancelMinutes >= 1 && autoCancelMinutes <= 240 ? autoCancelMinutes : 30,
      delayRulesV2: true,
      capacityFilterEnabled: value.settings?.capacityFilterEnabled !== false,
      capacityFilterValues: Array.isArray(value.settings?.capacityFilterValues) ? value.settings.capacityFilterValues : [2, 4, 6],
      capacityFilterRanges: capacityFilterRanges.length ? capacityFilterRanges : [{ min: 2, max: 2 }, { min: 4, max: 4 }, { min: 6, max: 6 }],
      quickPanelsEnabled: value.settings?.quickPanelsEnabled !== false,
      quickClockEntries: Array.isArray(value.settings?.quickClockEntries) ? value.settings.quickClockEntries.filter((e) => e && e.id && e.date && e.tableNumber && e.endTime) : [],
      waitingEntries: Array.isArray(value.settings?.waitingEntries) ? value.settings.waitingEntries.filter((e) => e && e.id && e.date && e.fullName) : [],
    },
  };
}

function initialState() {
  const today = toDateKey(new Date());
  const salon = 'area_salon';
  const bahce = 'area_bahce';
  return {
    areas: [
      { id: salon, name: 'Salon' },
      { id: bahce, name: 'Bahçe' },
    ],
    categories: [],
    tables: [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `s_${i + 1}`, areaId: salon, number: String(i + 1), capacity: 4, categoryId: null })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `b_${i + 1}`, areaId: bahce, number: String(i + 1), capacity: 4, categoryId: null })),
    ],
    settings: { upcomingMinutes: 30, overdueMinutes: 0, autoCancelMinutes: 30, delayRulesV2: true, capacityFilterEnabled: true, capacityFilterValues: [2, 4, 6], capacityFilterRanges: [{ min: 2, max: 2 }, { min: 4, max: 4 }, { min: 6, max: 6 }], quickPanelsEnabled: true, quickClockEntries: [], waitingEntries: [] },
    reservations: [
      { id: 'r1', date: today, areaId: salon, tableNumber: '1', fullName: 'Ahmet Yılmaz', people: 4, phone: '0532 111 22 33', time: '19:00', status: 'approved', important: false, note: '' },
      { id: 'r2', date: today, areaId: salon, tableNumber: '4', fullName: 'Mehmet Demir', people: 6, phone: '0532 333 66 77', time: '19:30', status: 'arrived', important: false, note: '' },
      { id: 'r3', date: today, areaId: salon, tableNumber: '7', fullName: 'Elif Şahin', people: 3, phone: '0534 444 88 99', time: '20:00', status: 'approved', important: true, note: '' },
      { id: 'r4', date: today, areaId: bahce, tableNumber: '2', fullName: 'Zeynep Kaya', people: 2, phone: '0533 222 44 55', time: '19:00', status: 'approved', important: false, note: '' },
      { id: 'r5', date: today, areaId: bahce, tableNumber: '8', fullName: 'Merve Çetin', people: 5, phone: '0533 666 77 88', time: '20:30', status: 'approved', important: false, note: '' },
      { id: 'r6', date: today, areaId: bahce, tableNumber: '12', fullName: 'Ali Yıldız', people: 2, phone: '0534 777 88 99', time: '21:00', status: 'approved', important: false, note: '' },
    ],
  };
}

// UI modals (form typing, manager settings) must not redraw the table board.
// Signature changes only when visible board content really changes.
const CachedReservationBoard = React.memo(
  function CachedReservationBoard({ children }) { return children; },
  (before, after) => before.signature === after.signature
);

function Logo() {
  return (
    <View style={styles.brandWrap}>
      <Image
        source={require('./assets/katilan-logo.png')}
        style={styles.brandLogo}
        resizeMode="cover"
        accessibilityLabel="Katılan logosu"
      />
      <View>
        <Text style={styles.brandName}>Katılan</Text>
        <Text style={styles.brandSub}>Rezervasyon Yönetimi</Text>
      </View>
    </View>
  );
}

const Chip = React.memo(function Chip({ active, label, count, onPress }) {
  const scale = useRef(new Animated.Value(1)).current;
  const changeScale = (toValue) => Animated.spring(scale, {
    toValue, useNativeDriver: true, tension: 260, friction: 16,
  }).start();
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable onPress={onPress} onPressIn={() => changeScale(0.96)} onPressOut={() => changeScale(1)} style={[styles.chip, active && styles.chipActive]}>
        <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
        {typeof count === 'number' && (
          <View style={[styles.countBadge, active && styles.countBadgeActive]}>
            <Text style={[styles.countText, active && styles.countTextActive]}>{count}</Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
});

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.approved;
  return (
    <View style={[styles.statusBadge, { backgroundColor: s.bg }]}>
      <Text style={[styles.statusText, { color: status === 'approved' ? COLORS.text : s.color }]}>{s.label}</Text>
    </View>
  );
}

function ModalShell({ visible, title, onClose, children, width = 520, scrollable = false, footer = null }) {
  const { height: windowHeight } = useWindowDimensions();
  const [webViewport, setWebViewport] = useState(null);
  const webInitialHeight = useRef(0);
  const [nativeKeyboardTop, setNativeKeyboardTop] = useState(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    webInitialHeight.current = Math.round(viewport?.height || window.innerHeight || windowHeight);

    const refreshViewport = () => {
      const height = Math.max(1, Math.round(viewport?.height || window.innerHeight || windowHeight));
      const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
      setWebViewport((previous) => previous?.height === height && previous?.top === top
        ? previous : { height, top });
    };

    const handleInputFocus = (event) => {
      const element = event.target;
      if (!element || !['INPUT', 'TEXTAREA'].includes(element.tagName)) return;
      // Klavye acilis animasyonundan sonra odakli alanin gorunur kalmasi.
      window.setTimeout(() => {
        if (document.activeElement === element) {
          element.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
      }, 180);
    };

    const handleOrientationChange = () => {
      webInitialHeight.current = Math.round(viewport?.height || window.innerHeight || windowHeight);
      refreshViewport();
    };
    refreshViewport();
    viewport?.addEventListener('resize', refreshViewport);
    viewport?.addEventListener('scroll', refreshViewport);
    window.addEventListener('resize', refreshViewport);
    window.addEventListener('orientationchange', handleOrientationChange);
    document.addEventListener('focusin', handleInputFocus);
    return () => {
      viewport?.removeEventListener('resize', refreshViewport);
      viewport?.removeEventListener('scroll', refreshViewport);
      window.removeEventListener('resize', refreshViewport);
      window.removeEventListener('orientationchange', handleOrientationChange);
      document.removeEventListener('focusin', handleInputFocus);
    };
  }, [visible]);

  useEffect(() => {
    if (Platform.OS === 'web' || !visible) return;
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      const top = event.endCoordinates?.screenY;
      setNativeKeyboardTop(Number.isFinite(top) ? Math.max(160, top) : null);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setNativeKeyboardTop(null));
    return () => { show.remove(); hide.remove(); };
  }, [visible]);

  const isWeb = Platform.OS === 'web';
  const webKeyboardOpen = isWeb && webViewport && webInitialHeight.current > 0
    && webViewport.height < webInitialHeight.current - 90;
  const keyboardOpen = !!(webKeyboardOpen || (!isWeb && nativeKeyboardTop !== null));
  const availableHeight = isWeb && webViewport
    ? webViewport.height
    : Math.min(windowHeight, nativeKeyboardTop ?? windowHeight);
  const maxCardHeight = Math.max(175, Math.floor(availableHeight - (keyboardOpen ? 12 : 30)));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[
          styles.modalBackdrop,
          isWeb && webViewport ? { flex: 0, position: 'absolute', left: 0, right: 0, height: webViewport.height, top: webViewport.top } : null,
          keyboardOpen ? { justifyContent: 'flex-start', paddingTop: 8, paddingBottom: 8 } : null,
        ]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={[styles.modalCard, { width: '90%', maxWidth: width, maxHeight: maxCardHeight, flexShrink: 1 }]}> 
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose} style={styles.iconButton}><Text style={styles.iconButtonText}>×</Text></Pressable>
          </View>
          {scrollable ? (
            <ScrollView
              style={styles.modalBodyScroll}
              nestedScrollEnabled
              keyboardShouldPersistTaps="always"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={keyboardOpen}
              contentContainerStyle={styles.modalScrollContent}
            >
              {children}
            </ScrollView>
          ) : children}
          {footer ? <View style={styles.stickyModalFooter}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, value, onChangeText, onBlur, placeholder, keyboardType = 'default', secureTextEntry = false, autoCapitalize = 'sentences', style }) {
  return (
    <View style={[styles.fieldWrap, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor="#98A2B3"
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        secureTextEntry={secureTextEntry}
        style={styles.field}
      />
    </View>
  );
}


function DraggableTableRow(props) {
  if (!props.enabled) {
    const { onPress, children, style } = props;
    if (onPress) {
      return <Pressable onPress={onPress} style={style}>{children}</Pressable>;
    }
    return <View style={style}>{children}</View>;
  }
  return <ActiveDraggableTableRow {...props} />;
}

function ActiveDraggableTableRow({
  enabled,
  index,
  rowStride,
  rowCount,
  shiftOffset = 0,
  onDragStart,
  onDragHover,
  onDrop,
  onPress,
  children,
  style,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const shiftY = useRef(new Animated.Value(0)).current;
  const dragging = useRef(false);
  const dragTimer = useRef(null);
  const suppressPress = useRef(false);
  const targetIndex = useRef(index);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const lastDragDy = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const onDragHoverRef = useRef(onDragHover);
  const onDropRef = useRef(onDrop);
  const onPressRef = useRef(onPress);

  useEffect(() => { onDragHoverRef.current = onDragHover; }, [onDragHover]);
  useEffect(() => { onDropRef.current = onDrop; }, [onDrop]);
  useEffect(() => { onPressRef.current = onPress; }, [onPress]);

  useEffect(() => () => {
    if (dragTimer.current) clearTimeout(dragTimer.current);
  }, []);

  useEffect(() => {
    if (isDragging) return;
    Animated.spring(shiftY, {
      toValue: shiftOffset,
      useNativeDriver: true,
      speed: 30,
      bounciness: 0,
    }).start();
  }, [shiftOffset, isDragging, shiftY]);

  const clearDragTimer = () => {
    if (dragTimer.current) {
      clearTimeout(dragTimer.current);
      dragTimer.current = null;
    }
  };

  const updateTarget = (dy) => {
    if (!dragging.current) return;
    lastDragDy.current = dy;
    translateY.setValue(dy);
    const rawTarget = index + Math.round(dy / Math.max(1, rowStride));
    const nextTarget = Math.max(0, Math.min(Math.max(0, rowCount - 1), rawTarget));
    if (targetIndex.current !== nextTarget) {
      targetIndex.current = nextTarget;
      onDragHoverRef.current?.(nextTarget);
    }
  };

  const startDrag = () => {
    if (!enabled || dragging.current) return;
    dragging.current = true;
    suppressPress.current = true;
    lastDragDy.current = 0;
    targetIndex.current = index;
    setIsDragging(true);
    onDragStart?.(index);
    Animated.spring(scale, {
      toValue: 0.94,
      useNativeDriver: true,
      speed: 30,
      bounciness: 2,
    }).start();
  };

  const finishDrag = () => {
    clearDragTimer();
    if (!dragging.current) return;
    const finalTarget = targetIndex.current;
    const snapOffset = (finalTarget - index) * rowStride;
    dragging.current = false;

    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 2 }),
      Animated.spring(translateY, { toValue: snapOffset, useNativeDriver: true, speed: 30, bounciness: 0 }),
    ]).start(() => {
      onDropRef.current?.(index, finalTarget);
      translateY.setValue(0);
      shiftY.setValue(0);
      targetIndex.current = finalTarget;
      setIsDragging(false);
      setTimeout(() => { suppressPress.current = false; }, 160);
    });
  };

  const beginHold = (evt) => {
    if (!enabled) return;
    const native = evt?.nativeEvent || {};
    touchStartY.current = Number(native.pageY ?? native.locationY ?? 0);
    touchStartX.current = Number(native.pageX ?? native.locationX ?? 0);
    lastDragDy.current = 0;
    clearDragTimer();
    dragTimer.current = setTimeout(() => {
      dragTimer.current = null;
      startDrag();
    }, 260);
  };

  const cancelHoldIfMoved = (evt) => {
    if (dragging.current || !dragTimer.current) return;
    const native = evt?.nativeEvent || {};
    const y = Number(native.pageY ?? native.locationY ?? touchStartY.current);
    const x = Number(native.pageX ?? native.locationX ?? touchStartX.current);
    if (Math.abs(y - touchStartY.current) > 8 || Math.abs(x - touchStartX.current) > 8) {
      clearDragTimer();
    }
  };

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponder: () => dragging.current,
    onMoveShouldSetPanResponderCapture: () => dragging.current,
    onPanResponderGrant: () => {},
    onPanResponderMove: (evt, gesture) => {
      const native = evt?.nativeEvent || {};
      const pageY = Number(native.pageY);
      const dy = Number.isFinite(pageY) && touchStartY.current
        ? pageY - touchStartY.current
        : gesture.dy;
      updateTarget(dy);
    },
    onPanResponderRelease: () => finishDrag(),
    onPanResponderTerminate: () => finishDrag(),
    onPanResponderTerminationRequest: () => !dragging.current,
    onShouldBlockNativeResponder: () => dragging.current,
  }), [enabled, index, rowStride, rowCount]);

  const handleTouchEnd = () => {
    const wasWaiting = !!dragTimer.current;
    clearDragTimer();
    if (dragging.current) {
      finishDrag();
      return;
    }
    if (wasWaiting && !suppressPress.current) {
      onPressRef.current?.();
    }
  };

  return (
    <Animated.View
      {...(enabled ? panResponder.panHandlers : {})}
      onTouchStart={enabled ? beginHold : undefined}
      onTouchMove={enabled ? cancelHoldIfMoved : undefined}
      onTouchEnd={enabled ? handleTouchEnd : undefined}
      onTouchCancel={enabled ? clearDragTimer : undefined}
      style={[
        enabled && isDragging && styles.draggingRowWrap,
        {
          transform: [
            { translateY: isDragging ? translateY : shiftY },
            { scale },
          ],
        },
      ]}
    >
      {!enabled && onPress ? (
        <Pressable onPress={onPress}>
          <View style={[style, enabled && isDragging && styles.draggingRow]}>{children}</View>
        </Pressable>
      ) : (
        <View style={[style, enabled && isDragging && styles.draggingRow]}>{children}</View>
      )}
    </Animated.View>
  );
}

export default function App() {
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const uiScale = Math.max(0.70, Math.min(1.12, viewportWidth / 1280));
  const pagePadding = Math.max(8, Math.round(18 * uiScale));
  const areaGap = Math.max(7, Math.round(12 * uiScale));
  const areaCardWidth = Math.max(0, (viewportWidth - (pagePadding * 2) - areaGap) / 2);
  // Alan başlıkları sabit kalırken, her alanın kendi masa listesi dikey kayar.
  // Kalan alan yüksekliğini ölçmek, düşük çözünürlüklü tabletlerde alt satırların
  // ekran dışına taşmasını da önler.
  const [areaViewportHeight, setAreaViewportHeight] = useState(0);
  const areaCardHeight = Math.max(150, areaViewportHeight > 0
    ? areaViewportHeight - pagePadding
    : viewportHeight - Math.round(164 * uiScale));
  const compactHeader = viewportWidth < 1080;

  const [data, setData] = useState(null);
  const [storageError, setStorageError] = useState('');
  const [dismissedLateAlerts, setDismissedLateAlerts] = useState({});
  const [historyDates, setHistoryDates] = useState([]);
  const [historySelected, setHistorySelected] = useState([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyVisibleCount, setHistoryVisibleCount] = useState(60);
  const [historyError, setHistoryError] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const savedDataRef = useRef(null);
  const savedDateRef = useRef(toDateKey(new Date()));
  const loadedDateRef = useRef(toDateKey(new Date()));
  const pendingSaveRef = useRef(Promise.resolve());
  const dataReadyRef = useRef(false);
  const dateSwitchInProgressRef = useRef(false);
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()));
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showAllTables, setShowAllTables] = useState(true);
  const [capacityFilterIndex, setCapacityFilterIndex] = useState(-1);
  const areaPagerRef = useRef(null);
  const [tableDragActive, setTableDragActive] = useState(false);
  const [dragPreview, setDragPreview] = useState(null);
  const [menuReservation, setMenuReservation] = useState(null);
  const [arrivalReservation, setArrivalReservation] = useState(null);
  const [seatedTableInput, setSeatedTableInput] = useState('');

  const [showTableModal, setShowTableModal] = useState(false);
  const [managementTab, setManagementTab] = useState('tables');
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminError, setAdminError] = useState('');

  const [showQuickClockModal, setShowQuickClockModal] = useState(false);
  const [quickClockNumber, setQuickClockNumber] = useState('');
  const [quickClockEndTime, setQuickClockEndTime] = useState('');
  const [showWaitingModal, setShowWaitingModal] = useState(false);
  const [waitingName, setWaitingName] = useState('');
  const [showAreaModal, setShowAreaModal] = useState(false);
  const [renameArea, setRenameArea] = useState(null);
  const [newAreaName, setNewAreaName] = useState('');
  const [timedAreaEnabled, setTimedAreaEnabled] = useState(false);
  const [clockAreaEnabled, setClockAreaEnabled] = useState(false);
  const [areaStartTime, setAreaStartTime] = useState('19:00');
  const [areaEndTime, setAreaEndTime] = useState('20:00');
  const [newCategoryName, setNewCategoryName] = useState('');

  const [showReservationModal, setShowReservationModal] = useState(false);
  const [reservationPreset, setReservationPreset] = useState(null);
  const [editingReservation, setEditingReservation] = useState(null);
  const [formAreaId, setFormAreaId] = useState('');
  const [formTable, setFormTable] = useState('');
  const [formName, setFormName] = useState('');
  const [formPeople, setFormPeople] = useState('');
  const [formPhone, setFormPhone] = useState('05');
  const [formTime, setFormTime] = useState('');
  const [formEndTime, setFormEndTime] = useState('');

  const [upcomingMinutesInput, setUpcomingMinutesInput] = useState('30');
  const [overdueMinutesInput, setOverdueMinutesInput] = useState('0');
  const [autoCancelMinutesInput, setAutoCancelMinutesInput] = useState('30');
  const [capacityValuesInput, setCapacityValuesInput] = useState('2, 4, 6');
  const [moveReservation, setMoveReservation] = useState(null);
  const [moveAreaId, setMoveAreaId] = useState('');
  const [moveTableNumber, setMoveTableNumber] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);

  const [bulkAreaId, setBulkAreaId] = useState('');
  const [startTable, setStartTable] = useState('1');
  const [endTable, setEndTable] = useState('80');
  const [singleTableName, setSingleTableName] = useState('');
  const [newTableCapacity, setNewTableCapacity] = useState('4');
  const [newTableCategoryId, setNewTableCategoryId] = useState('');
  const [editTable, setEditTable] = useState(null);
  const [editTableName, setEditTableName] = useState('');
  const [editTableCapacity, setEditTableCapacity] = useState('4');
  const [editTableCategoryId, setEditTableCategoryId] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteTable, setNoteTable] = useState(null);
  const [noteReservationId, setNoteReservationId] = useState(null);

  const [now, setNow] = useState(new Date());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const dateKey = toDateKey(new Date());
        const parsed = await loadAppState({ storageKey: STORAGE_KEY, normalize: normalizeStoredData, fallback: initialState, dateKey });
        if (cancelled) return;
        savedDataRef.current = parsed;
        savedDateRef.current = dateKey;
        loadedDateRef.current = dateKey;
        dataReadyRef.current = true;
        setData(parsed);
        const firstAreaId = parsed.areas?.[0]?.id || '';
        setBulkAreaId(firstAreaId);
        setFormAreaId(firstAreaId);
        setFormTable(parsed.tables.find((t) => t.areaId === firstAreaId)?.number || '');
        setUpcomingMinutesInput(String(parsed.settings?.upcomingMinutes || 30));
        setOverdueMinutesInput(String(parsed.settings?.overdueMinutes ?? 0));
        setAutoCancelMinutesInput(String(parsed.settings?.autoCancelMinutes ?? 30));
        setCapacityValuesInput(normalizeCapacityRanges(parsed.settings).map(formatCapacityRange).join(', '));
      } catch (error) {
        if (!cancelled) setStorageError(`Veriler açılamadı: ${error?.message || String(error)}. Eski kayıtlar silinmedi.`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!data || !dataReadyRef.current || dateSwitchInProgressRef.current) return;
    // Loading a date is not a user edit: avoid unnecessary writes.
    if (data === savedDataRef.current && loadedDateRef.current === savedDateRef.current) return;
    const snapshot = data;
    const dateKey = loadedDateRef.current;
    pendingSaveRef.current = pendingSaveRef.current
      .then(async () => {
        await persistAppState(savedDataRef.current, snapshot, dateKey, savedDateRef.current);
        savedDataRef.current = snapshot;
        savedDateRef.current = dateKey;
      })
      .catch((error) => { setStorageError(`Kaydetme hatası: ${error?.message || String(error)}`); });
  }, [data]);

  const navigateToDate = async (nextDate) => {
    if (dateSwitchInProgressRef.current || nextDate === selectedDate) return;
    dateSwitchInProgressRef.current = true;
    try {
      await pendingSaveRef.current;
      const reservations = await loadDateReservations(nextDate);
      const nextSnapshot = { ...data, reservations };
      loadedDateRef.current = nextDate;
      savedDateRef.current = nextDate;
      savedDataRef.current = nextSnapshot;
      setSelectedDate(nextDate);
      setData(nextSnapshot);
    } catch (error) {
      setStorageError(`Tarih yüklenemedi: ${error?.message || String(error)}`);
    } finally {
      dateSwitchInProgressRef.current = false;
    }
  };

  // Sabit kurumsal mavi: eski cihaz ayarlarında farklı renk saklansa bile değişmez.
  const themeColor = '#2563EB';

  useEffect(() => {
    // Gecikme/iptal sürelerini 15 saniyede bir kontrol et. Görsel alarm yok.
    const timer = setInterval(() => {
      const current = new Date();
      setNow((previous) => previous.getFullYear() === current.getFullYear() &&
        previous.getMonth() === current.getMonth() && previous.getDate() === current.getDate() &&
        previous.getHours() === current.getHours() && previous.getMinutes() === current.getMinutes()
          ? previous : current);
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => sub.remove();
  }, []);

  const clockAreaIds = useMemo(() => new Set((data?.areas || []).filter((a) => a.clockArea).map((a) => a.id)), [data?.areas]);

  // Only today's approved real reservations expire. This updates the stored
  // status exactly once; it never deletes reservations or guest/table notes.
  useEffect(() => {
    if (!data || !dataReadyRef.current || dateSwitchInProgressRef.current || selectedDate !== toDateKey(now)) return;
    const cancelAfter = data.settings?.autoCancelMinutes ?? 30;
    if (!Number.isFinite(cancelAfter)) return;
    const due = new Set(data.reservations.filter((r) => !clockAreaIds.has(r.areaId) && !isTestReservation(r) && reservationDelayMinutes(r, now) >= cancelAfter).map((r) => r.id));
    if (!due.size) return;
    setData((prev) => ({
      ...prev,
      reservations: prev.reservations.map((r) => due.has(r.id) && r.status === 'approved'
        ? { ...r, status: 'cancelled', autoCancelled: true, seatedTable: '', guestArrived: false }
        : r),
    }));
  }, [now, selectedDate, data, clockAreaIds]);

  // Uygulama açıldığında mevcut saatli masaların bildirimlerini güvenli biçimde eşitle.
  // Uyarı planlama hiçbir zaman ilk ekranın çizilmesini bekletmez.
  const clockAlertDatesReady = useRef(new Set());
  useEffect(() => {
    if (!data || clockAlertDatesReady.current.has(selectedDate)) return;
    clockAlertDatesReady.current.add(selectedDate);
    const clockAreas = new Set(data.areas.filter((a) => a.clockArea).map((a) => a.id));
    data.reservations.filter((r) => clockAreas.has(r.areaId) && r.status !== 'cancelled' && !isTestReservation(r)).forEach((r) => scheduleClockAlert(r, { askPermission: false }));
  }, [data, selectedDate]);

  // Restore local expiry notifications after a new installation/restart or day selection.
  // A scheduled notification is keyed by entry ID and is idempotent.
  useEffect(() => {
    if (!data?.settings?.quickPanelsEnabled) return;
    (data.settings.quickClockEntries || []).forEach((entry) => scheduleClockAlert(entry, { askPermission: false }));
  }, [selectedDate, data?.settings?.quickPanelsEnabled, data?.settings?.quickClockEntries]);

  const tablesByArea = useMemo(() => {
    const map = new Map();
    (data?.tables || []).forEach((table) => {
      if (!map.has(table.areaId)) map.set(table.areaId, []);
      map.get(table.areaId).push(table);
    });
    return map;
  }, [data?.tables]);


  const categoriesByArea = useMemo(() => {
    const map = new Map();
    (data?.categories || []).forEach((category) => {
      if (!map.has(category.areaId)) map.set(category.areaId, []);
      map.get(category.areaId).push(category);
    });
    return map;
  }, [data?.categories]);

  const tableLookup = useMemo(() => {
    const map = new Map();
    (data?.tables || []).forEach((table) => map.set(`${table.areaId}::${tableKey(table.number)}`, table));
    return map;
  }, [data?.tables]);

  const categoryLookup = useMemo(() => {
    const map = new Map();
    (data?.categories || []).forEach((category) => map.set(category.id, category));
    return map;
  }, [data?.categories]);

  const areaTables = (areaId) => tablesByArea.get(areaId) || [];
  const areaCategories = (areaId) => categoriesByArea.get(areaId) || [];
  const getTable = (areaId, tableNumber) => tableLookup.get(`${areaId}::${tableKey(tableNumber)}`);
  const getCategory = (categoryId) => categoryLookup.get(categoryId);

  const clockLate = (reservation) => clockAreaIds.has(reservation?.areaId) && !isTestReservation(reservation) && isClockReservationLate(reservation, now);
  const listTimeTick = filter === 'upcoming' || filter === 'overdue' || filter === 'all' ? now : null;
  const areaListExtraData = useMemo(() => ({ dragPreview, isAdmin, search, filter, showAllTables, capacityFilterIndex, areaCardHeight, areaCardWidth, uiScale, data, listTimeTick, tableDragActive, selectedDate }),
    [dragPreview, isAdmin, search, filter, showAllTables, capacityFilterIndex, areaCardHeight, areaCardWidth, uiScale, data, listTimeTick, tableDragActive, selectedDate]);

  const todaysReservations = useMemo(() => {
    if (!data) return [];
    return data.reservations.filter((r) => r.date === selectedDate && !isTestReservation(r));
  }, [data?.reservations, selectedDate]);

  const todaysTestReservations = useMemo(() => {
    if (!data) return [];
    return data.reservations.filter((r) => r.date === selectedDate && isTestReservation(r));
  }, [data?.reservations, selectedDate]);

  const firstActiveReservationByTable = useMemo(() => {
    const map = new Map();
    todaysReservations.forEach((reservation) => {
      if (reservation.status === 'cancelled') return;
      const key = `${reservation.areaId}::${tableKey(reservation.tableNumber)}`;
      const current = map.get(key);
      if (!current || reservation.time.localeCompare(current.time) < 0) map.set(key, reservation);
    });
    return map;
  }, [todaysReservations]);

  const filteredReservations = useMemo(() => {
    const q = normalizedSearch(search.trim());
    const upcomingMinutes = data?.settings?.upcomingMinutes || 30;
    const source = filter === 'test' ? (isAdmin ? todaysTestReservations : []) : todaysReservations;
    const result = source.filter((r) => {
      const minutesUntil = reservationMinutesUntil(r, now);
      const matchesFilter =
        filter === 'all' || filter === 'test' ? true :
        filter === 'important' ? (!!String(r.note || '').trim() || !!noteForDay(tableLookup.get(`${r.areaId}::${tableKey(r.tableNumber)}`), selectedDate)) :
        filter === 'empty' ? false :
        filter === 'upcoming' ? !clockAreaIds.has(r.areaId) && minutesUntil !== null && minutesUntil >= 0 && minutesUntil <= upcomingMinutes :
        filter === 'overdue' ? (clockLate(r) || (!clockAreaIds.has(r.areaId) && reservationDelayMinutes(r, now) >= (data?.settings?.overdueMinutes ?? 0) && reservationDelayMinutes(r, now) < (data?.settings?.autoCancelMinutes ?? 30))) :
        r.status === filter;
      const matchesSearch = !q ||
        normalizedSearch(r.fullName).includes(q) ||
        normalizedSearch(r.phone).replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
        normalizedSearch(r.tableNumber).includes(q);
      return matchesFilter && matchesSearch;
    });
    if (filter === 'overdue') return result.sort((a, b) => (b.endTime || b.time).localeCompare(a.endTime || a.time));
    if (filter === 'upcoming') {
      return result.sort((a, b) => {
        const am = reservationMinutesUntil(a, now) ?? Number.MAX_SAFE_INTEGER;
        const bm = reservationMinutesUntil(b, now) ?? Number.MAX_SAFE_INTEGER;
        return am - bm || a.time.localeCompare(b.time);
      });
    }
    return result.sort((a, b) => a.time.localeCompare(b.time));
  }, [todaysReservations, todaysTestReservations, isAdmin, search, filter, now, data?.settings?.upcomingMinutes, data?.settings?.overdueMinutes, data?.settings?.autoCancelMinutes, data?.tables, selectedDate, tableLookup, clockAreaIds]);

  const counts = useMemo(() => {
    const upcomingMinutes = data?.settings?.upcomingMinutes || 30;
    const reservedTableKeys = new Set(todaysReservations.map((r) => `${r.areaId}::${tableKey(r.tableNumber)}`));
    return {
      all: todaysReservations.length,
      test: todaysTestReservations.length,
      empty: (data?.tables || []).filter((t) => !firstActiveReservationByTable.has(`${t.areaId}::${tableKey(t.number)}`)).length,
      overdue: todaysReservations.filter((r) => clockLate(r) || (!clockAreaIds.has(r.areaId) && reservationDelayMinutes(r, now) >= (data?.settings?.overdueMinutes ?? 0) && reservationDelayMinutes(r, now) < (data?.settings?.autoCancelMinutes ?? 30))).length,
      upcoming: todaysReservations.filter((r) => {
        const minutesUntil = reservationMinutesUntil(r, now);
        return !clockAreaIds.has(r.areaId) && minutesUntil !== null && minutesUntil >= 0 && minutesUntil <= upcomingMinutes;
      }).length,
      arrived: todaysReservations.filter((r) => r.status === 'arrived').length,
      cancelled: todaysReservations.filter((r) => r.status === 'cancelled').length,
      important: todaysReservations.filter((r) => String(r.note || '').trim() || noteForDay(tableLookup.get(`${r.areaId}::${tableKey(r.tableNumber)}`), selectedDate)).length +
        (data?.tables || []).filter((t) => noteForDay(t, selectedDate) &&
          !reservedTableKeys.has(`${t.areaId}::${tableKey(t.number)}`)).length,
    };
  }, [todaysReservations, todaysTestReservations, now, data?.settings?.upcomingMinutes, data?.settings?.overdueMinutes, data?.settings?.autoCancelMinutes, data?.tables, selectedDate, firstActiveReservationByTable, clockAreaIds]);

  if (!data) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <StatusBar barStyle="dark-content" />
        <Logo />
        <Text style={styles.loadingText}>{storageError || 'Katılan hazırlanıyor…'}</Text>
      </SafeAreaView>
    );
  }

  const showQuickPanels = data.settings?.quickPanelsEnabled === true && showAllTables && filter === 'all';
  const boardAreas = showQuickPanels ? [...data.areas, { id: OPTIONAL_AREA_ID, name: 'Hızlı İşlemler' }] : data.areas;
  const quickLateCount = quickClockActiveLateCount(data.settings, now);
  const capacityOptions = normalizeCapacityRanges(data.settings);
  const currentCapacity = showAllTables && data.settings?.capacityFilterEnabled !== false && capacityFilterIndex >= 0 && capacityOptions.length
    ? capacityOptions[capacityFilterIndex % capacityOptions.length] : null;
  const buildAreaGroups = (areaId) => {
    let rows;
    if ((showAllTables && filter === 'all') || filter === 'empty') {
      const q = normalizedSearch(search.trim());
      rows = areaTables(areaId).map((table) => {
        const reservation = firstActiveReservationByTable.get(`${areaId}::${tableKey(table.number)}`);
        return reservation
          ? { kind: 'reservation', reservation, table, tableNumber: table.number }
          : { kind: 'empty', table, tableNumber: table.number };
      }).filter((row) => {
        const peopleOrCapacity = row.kind === 'reservation' ? Number(row.reservation.people) : Number(row.table.capacity);
        if (currentCapacity !== null && !(peopleOrCapacity >= currentCapacity.min && peopleOrCapacity <= currentCapacity.max)) return false;
        if (filter === 'empty' && row.kind !== 'empty') return false;
        if (!q) return true;
        if (normalizedSearch(row.tableNumber).includes(q)) return true;
        return row.kind === 'reservation' && (
          normalizedSearch(row.reservation.fullName).includes(q) ||
          normalizedSearch(row.reservation.phone).replace(/\s/g, '').includes(q.replace(/\s/g, ''))
        );
      });
    } else {
      rows = filteredReservations
        .filter((r) => r.areaId === areaId)
        .map((reservation) => ({
          kind: 'reservation',
          reservation,
          table: getTable(areaId, reservation.tableNumber),
          tableNumber: reservation.tableNumber,
        }));
      if (filter === 'important') {
        const notedReservationTables = new Set(rows.map((row) => `${areaId}::${tableKey(row.tableNumber)}`));
        rows.push(...areaTables(areaId).filter((table) =>
          noteForDay(table, selectedDate) && !notedReservationTables.has(`${areaId}::${tableKey(table.number)}`) &&
          !firstActiveReservationByTable.has(`${areaId}::${tableKey(table.number)}`) &&
          (!search.trim() || normalizedSearch(table.number).includes(normalizedSearch(search.trim())))
        ).map((table) => ({ kind: 'empty', table, tableNumber: table.number })));
      }
    }

    const categories = areaCategories(areaId);
    if (!categories.length) return [{ id: '__all__', categoryId: null, label: null, rows }];

    const result = categories.map((category) => ({
      id: category.id,
      categoryId: category.id,
      label: category.name,
      rows: rows.filter((row) => (row.table?.categoryId || null) === category.id),
    })).filter((group) => group.rows.length > 0);

    const ungrouped = rows.filter((row) => !row.table?.categoryId);
    if (ungrouped.length) result.push({ id: '__uncategorized__', categoryId: null, label: 'Diğer', rows: ungrouped });
    return result;
  };

  const reorderTableWithinGroup = (areaId, categoryId, fromIndex, rawToIndex) => {
    const groupTables = areaTables(areaId).filter((t) => (t.categoryId || null) === (categoryId || null));
    if (!groupTables.length) return;
    const toIndex = Math.max(0, Math.min(groupTables.length - 1, rawToIndex));
    if (fromIndex === toIndex) return;
    const reordered = [...groupTables];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    let cursor = 0;
    setData((prev) => ({
      ...prev,
      tables: prev.tables.map((table) => (
        table.areaId === areaId && (table.categoryId || null) === (categoryId || null)
          ? reordered[cursor++]
          : table
      )),
    }));
  };

  const updateReservation = (reservationId, patch) => {
    setData((prev) => ({
      ...prev,
      reservations: prev.reservations.map((r) => r.id === reservationId ? { ...r, ...patch } : r),
    }));
  };

  const handleAdminLogin = () => {
    if (adminUsername.trim() === ADMIN_USERNAME && adminPassword === ADMIN_PASSWORD) {
      setIsAdmin(true);
      setAdminError('');
      setAdminUsername('');
      setAdminPassword('');
      setShowAdminLogin(false);
      setManagementTab('tables');
      setShowTableModal(true);
      return;
    }
    setAdminError('Kullanıcı adı veya şifre hatalı.');
  };

  const logoutAdmin = () => {
    setIsAdmin(false);
    if (filter === 'test') { setFilter('all'); setShowAllTables(true); }
    setShowTableModal(false);
    setTableDragActive(false);
    setDragPreview(null);
  };

  const openManagement = () => {
    if (!isAdmin) return;
    if (!bulkAreaId && data.areas[0]) setBulkAreaId(data.areas[0].id);
    setUpcomingMinutesInput(String(data.settings?.upcomingMinutes || 30));
    setOverdueMinutesInput(String(data.settings?.overdueMinutes ?? 0));
    setAutoCancelMinutesInput(String(data.settings?.autoCancelMinutes ?? 30));
    setCapacityValuesInput(normalizeCapacityRanges(data.settings).map(formatCapacityRange).join(', '));
    setShowTableModal(true);
  };

  const openAreaEditor = (area = null) => {
    setNewAreaName(area?.name || '');
    setTimedAreaEnabled(area?.timedArea === true);
    setClockAreaEnabled(area?.clockArea === true);
    setAreaStartTime(area?.defaultStartTime || '19:00');
    setAreaEndTime(area?.defaultEndTime || '20:00');
    if (area) setRenameArea(area);
    else setShowAreaModal(true);
  };

  const validatedAreaTiming = () => {
    // Preserve legacy Clock Area on edits; new Clock Area creation is disabled.
    if (renameArea?.clockArea) return { clockArea: true, timedArea: false, defaultStartTime: '', defaultEndTime: '' };
    if (!timedAreaEnabled) return { clockArea: false, timedArea: false, defaultStartTime: '', defaultEndTime: '' };
    const start = parseReservationTime(areaStartTime);
    const end = parseReservationTime(areaEndTime);
    if (!start || !end) {
      Alert.alert('Saatleri kontrol edin', 'Geliş ve kalkış saatlerini 19:00 gibi geçerli bir biçimde girin.');
      return null;
    }
    if (start.minutes === end.minutes) {
      Alert.alert('Saatleri kontrol edin', 'Geliş ve kalkış saati aynı olamaz.');
      return null;
    }
    return {
      clockArea: false,
      timedArea: true,
      defaultStartTime: `${pad(start.hour)}:${pad(start.minute)}`,
      defaultEndTime: `${pad(end.hour)}:${pad(end.minute)}`,
    };
  };

  const addArea = () => {
    const name = newAreaName.trim();
    if (!name) return Alert.alert('Alan adı gerekli', 'Yeni alan için bir isim girin.');
    const timing = validatedAreaTiming();
    if (!timing) return;
    const area = { id: id('area'), name, ...timing };
    setData((prev) => ({ ...prev, areas: [...prev.areas, area] }));
    setNewAreaName('');
    setShowAreaModal(false);
    setBulkAreaId(area.id);
  };

  const saveAreaName = () => {
    const name = newAreaName.trim();
    if (!renameArea || !name) return Alert.alert('Alan adı gerekli', 'Alan için bir isim girin.');
    const timing = validatedAreaTiming();
    if (!timing) return;
    setData((prev) => ({ ...prev, areas: prev.areas.map((a) => a.id === renameArea.id ? { ...a, name, ...timing } : a) }));
    if (!timing.clockArea) cancelClockAlertsForArea(renameArea.id);
    setRenameArea(null);
    setNewAreaName('');
  };

  const deleteArea = (area) => {
    if (data.areas.length <= 1) {
      return Alert.alert('Alan silinemedi', 'En az bir alan kalmalı.');
    }
    const tableCount = data.tables.filter((t) => t.areaId === area.id).length;
    const reservationCount = data.reservations.filter((r) => r.areaId === area.id).length;
    setPendingDelete({
      type: 'area', area,
      title: `${area.name} silinsin mi?`,
      message: `Bu alanla birlikte ${tableCount} masa ve ${reservationCount} rezervasyon kalıcı olarak silinecek.`,
    });
  };

  const addCategory = () => {
    const name = newCategoryName.trim();
    if (!bulkAreaId || !name) return;
    if (areaCategories(bulkAreaId).some((c) => c.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'))) {
      return Alert.alert('Kategori zaten var', 'Aynı alanda aynı kategori adını iki kez kullanamazsınız.');
    }
    const category = { id: id('category'), areaId: bulkAreaId, name };
    setData((prev) => ({ ...prev, categories: [...(prev.categories || []), category] }));
    setNewCategoryName('');
    setNewTableCategoryId(category.id);
  };

  const deleteCategory = (category) => {
    setPendingDelete({
      type: 'category', category,
      title: `${category.name} kategorisi silinsin mi?`,
      message: 'Kategori silinecek. Bu kategorideki masalar silinmeyecek; yalnızca kategorisiz hale gelecek.',
    });
  };

  const createTables = () => {
    const start = Number(startTable);
    const end = Number(endTable);
    const capacity = Number(newTableCapacity);
    if (!bulkAreaId || data.areas.find((a) => a.id === bulkAreaId)?.clockArea) return Alert.alert('Normal alan seçin', 'Saatli Masalar yalnızca Hızlı İşlemler panelinden eklenir.');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 999) {
      return Alert.alert('Geçersiz aralık', 'Başlangıç ve son masa numarasını kontrol edin.');
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99) return Alert.alert('Kapasiteyi kontrol edin', 'Masa kapasitesi 1-99 kişi arasında olmalı.');
    const validCategory = areaCategories(bulkAreaId).some((c) => c.id === newTableCategoryId) ? newTableCategoryId : null;
    const existing = new Set(areaTables(bulkAreaId).map((t) => tableKey(t.number)));
    const additions = [];
    for (let n = start; n <= end; n += 1) {
      const label = String(n);
      if (!existing.has(tableKey(label))) additions.push({ id: id('table'), areaId: bulkAreaId, number: label, capacity, categoryId: validCategory });
    }
    setData((prev) => ({ ...prev, tables: [...prev.tables, ...additions] }));
    Alert.alert('Masalar hazır', `${additions.length} yeni masa oluşturuldu.`);
  };

  const createSingleTable = () => {
    const label = singleTableName.trim();
    const capacity = Number(newTableCapacity);
    if (!bulkAreaId || data.areas.find((a) => a.id === bulkAreaId)?.clockArea) return Alert.alert('Normal alan seçin', 'Saatli Masalar yalnızca Hızlı İşlemler panelinden eklenir.');
    if (!label) return Alert.alert('Masa adı gerekli', 'Örneğin 21, Salon 1 veya VIP A yazabilirsiniz.');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99) return Alert.alert('Kapasiteyi kontrol edin', 'Masa kapasitesi 1-99 kişi arasında olmalı.');
    const exists = areaTables(bulkAreaId).some((t) => tableKey(t.number) === tableKey(label));
    if (exists) return Alert.alert('Bu masa zaten var', 'Aynı alanda aynı masa adı iki kez kullanılamaz.');
    const validCategory = areaCategories(bulkAreaId).some((c) => c.id === newTableCategoryId) ? newTableCategoryId : null;
    setData((prev) => ({ ...prev, tables: [...prev.tables, { id: id('table'), areaId: bulkAreaId, number: label, capacity, categoryId: validCategory }] }));
    setSingleTableName('');
  };

  const openTableEdit = (table) => {
    setEditTable(table);
    setEditTableName(String(table.number));
    setEditTableCapacity(String(table.capacity || 4));
    setEditTableCategoryId(table.categoryId || '');
  };

  const saveTableEdit = () => {
    if (!editTable) return;
    const name = editTableName.trim();
    const capacity = Number(editTableCapacity);
    if (!name) return Alert.alert('Masa adı gerekli');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 99) return Alert.alert('Kapasiteyi kontrol edin', 'Masa kapasitesi 1-99 kişi arasında olmalı.');
    const duplicate = areaTables(editTable.areaId).some((t) => t.id !== editTable.id && tableKey(t.number) === tableKey(name));
    if (duplicate) return Alert.alert('Bu masa adı kullanılıyor');
    const oldNumber = editTable.number;
    const categoryId = areaCategories(editTable.areaId).some((c) => c.id === editTableCategoryId) ? editTableCategoryId : null;
    setData((prev) => ({
      ...prev,
      tables: prev.tables.map((t) => t.id === editTable.id ? { ...t, number: name, capacity, categoryId } : t),
      reservations: prev.reservations.map((r) => (
        r.areaId === editTable.areaId && tableKey(r.tableNumber) === tableKey(oldNumber)
          ? { ...r, tableNumber: name }
          : r
      )),
    }));
    setEditTable(null);
  };

  const deleteTable = (table) => {
    const area = data.areas.find((a) => a.id === table.areaId);
    const reservationCount = data.reservations.filter((r) => r.areaId === table.areaId && tableKey(r.tableNumber) === tableKey(table.number)).length;
    setPendingDelete({
      type: 'table', table,
      title: `${tableLabel(table.number, true)} silinsin mi?`,
      message: reservationCount ? `${area?.name || 'Alan'} içindeki bu masaya bağlı ${reservationCount} rezervasyon da silinecek.` : `${area?.name || 'Alan'} içindeki masa kaldırılacak.`,
    });
  };

  const deleteAllTablesInArea = () => {
    const area = data.areas.find((a) => a.id === bulkAreaId);
    const tables = areaTables(bulkAreaId);
    if (!area || !tables.length) return;
    const reservationCount = data.reservations.filter((r) => r.areaId === bulkAreaId).length;
    setPendingDelete({
      type: 'allTables', area,
      title: `${area.name} içindeki tüm masalar silinsin mi?`,
      message: `${tables.length} masa${reservationCount ? ` ve bu alana bağlı ${reservationCount} rezervasyon` : ''} kalıcı olarak silinecek.`,
    });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === 'testData') {
      if (!isAdmin || testBusy) return;
      setTestBusy(true);
      try {
        await pendingSaveRef.current;
        const result = await deleteAllTestReservations();
        const currentRecords = await loadDateReservations(selectedDate);
        const nextSnapshot = { ...data, reservations: currentRecords };
        savedDataRef.current = nextSnapshot;
        savedDateRef.current = selectedDate;
        loadedDateRef.current = selectedDate;
        setData(nextSnapshot);
        setPendingDelete(null);
        if (filter === 'test') { setFilter('all'); setShowAllTables(true); }
        Alert.alert('Test verileri temizlendi', `${result.deletedReservations} test rezervasyonu ${result.affectedDays} tarihten silindi. Gerçek rezervasyonlar korunuyor.`);
      } catch (error) {
        setPendingDelete(null);
        Alert.alert('Temizleme tamamlanamadı', error?.message || String(error));
      } finally {
        setTestBusy(false);
      }
      return;
    }
    if (pendingDelete.type === 'history') {
      const days = pendingDelete.dateKeys;
      setHistoryBusy(true);
      setHistoryError('');
      try {
        await pendingSaveRef.current;
        const result = await deleteReservationHistoryDates(days, toDateKey(new Date()));
        const updatedHistory = await listReservationHistoryDates(toDateKey(new Date()));
        setHistoryDates(updatedHistory);
        setHistorySelected([]);
        // If the user was viewing a deleted day, switch to today without
        // accidentally re-saving the deleted reservation snapshot.
        if (days.includes(selectedDate)) {
          const today = toDateKey(new Date());
          const todayRecords = await loadDateReservations(today);
          const nextSnapshot = { ...data, reservations: todayRecords };
          savedDataRef.current = nextSnapshot;
          savedDateRef.current = today;
          loadedDateRef.current = today;
          setSelectedDate(today);
          setData(nextSnapshot);
        }
        setPendingDelete(null);
        Alert.alert('Geçmiş temizlendi', `${result.deletedDays} gün, ${result.deletedReservations} rezervasyon silindi.`);
      } catch (error) {
        setHistoryError(`Silme işlemi tamamlanamadı: ${error?.message || String(error)}`);
        Alert.alert('Silinemedi', 'Veriler silinirken hata oluştu. Kayıtları tekrar kontrol edin.');
        setPendingDelete(null);
      } finally { setHistoryBusy(false); }
      return;
    }
    if (pendingDelete.type === 'area') {
      const area = pendingDelete.area;
      cancelClockAlertsForArea(area.id);
      const remaining = data.areas.filter((a) => a.id !== area.id);
      setData((prev) => ({
        ...prev,
        areas: prev.areas.filter((a) => a.id !== area.id),
        categories: (prev.categories || []).filter((c) => c.areaId !== area.id),
        tables: prev.tables.filter((t) => t.areaId !== area.id),
        reservations: prev.reservations.filter((r) => r.areaId !== area.id),
      }));
      if (bulkAreaId === area.id) setBulkAreaId(remaining[0]?.id || '');
    }
    if (pendingDelete.type === 'category') {
      const category = pendingDelete.category;
      setData((prev) => ({
        ...prev,
        categories: (prev.categories || []).filter((c) => c.id !== category.id),
        tables: prev.tables.map((t) => t.categoryId === category.id ? { ...t, categoryId: null } : t),
      }));
      if (newTableCategoryId === category.id) setNewTableCategoryId('');
    }
    if (pendingDelete.type === 'table') {
      const table = pendingDelete.table;
      data.reservations.filter((r) => r.areaId === table.areaId && tableKey(r.tableNumber) === tableKey(table.number)).forEach((r) => cancelClockAlert(r.id));
      setData((prev) => ({
        ...prev,
        tables: prev.tables.filter((t) => t.id !== table.id),
        reservations: prev.reservations.filter((r) => !(r.areaId === table.areaId && tableKey(r.tableNumber) === tableKey(table.number))),
      }));
    }
    if (pendingDelete.type === 'allTables') {
      const area = pendingDelete.area;
      cancelClockAlertsForArea(area.id);
      setData((prev) => ({ ...prev, tables: prev.tables.filter((t) => t.areaId !== area.id), reservations: prev.reservations.filter((r) => r.areaId !== area.id) }));
    }
    if (pendingDelete.type === 'reservation') {
      const reservation = pendingDelete.reservation;
      cancelClockAlert(reservation.id);
      setData((prev) => ({
        ...prev,
        reservations: prev.reservations.filter((r) => r.id !== reservation.id),
        tables: prev.tables.some((t) => t.areaId === reservation.areaId && tableKey(t.number) === tableKey(reservation.tableNumber) && noteForDay(t, reservation.date))
          ? prev.tables.map((t) => t.areaId === reservation.areaId && tableKey(t.number) === tableKey(reservation.tableNumber)
            ? withDayNote(t, reservation.date, '') : t)
          : prev.tables,
      }));
    }
    setPendingDelete(null);
  };

  const openHistoryManager = async () => {
    setManagementTab('history');
    setHistorySelected([]);
    setHistoryVisibleCount(60);
    setHistoryError('');
    setHistoryBusy(true);
    try {
      await pendingSaveRef.current;
      setHistoryDates(await listReservationHistoryDates(toDateKey(new Date())));
    } catch (error) {
      setHistoryError(`Geçmiş günler okunamadı: ${error?.message || String(error)}`);
    } finally { setHistoryBusy(false); }
  };

  const toggleHistoryDate = (date) => {
    setHistorySelected((selected) => selected.includes(date) ? selected.filter((item) => item !== date) : [...selected, date]);
  };

  const requestHistoryDeletion = () => {
    const selected = historyDates.filter((day) => historySelected.includes(day.date));
    if (!selected.length) return;
    const total = selected.reduce((sum, day) => sum + day.count, 0);
    setPendingDelete({
      type: 'history',
      dateKeys: selected.map((day) => day.date),
      title: 'Geçmiş Rezervasyonlar Silinsin mi?',
      message: `${selected.length} geçmiş günün toplam ${total} rezervasyonu kalıcı olarak silinecek. Bugün ve gelecek günler etkilenmez.`,
    });
  };

  // Test verisi yalnızca yönetici tarafından oluşturulur. Tek seferde
  // kaydedilir; gerçek rezervasyonlar veya diğer tarihler değiştirilmez.
  const createTestReservations = async (count) => {
    if (!isAdmin || testBusy || !data || ![100, 500, 1000].includes(count)) return;
    if (dateSwitchInProgressRef.current) return;
    if (!data.tables.length) {
      Alert.alert('Masa gerekli', 'Önce Yönetim > Masalar bölümünden en az bir masa ekleyin.');
      return;
    }
    setTestBusy(true);
    try {
      await pendingSaveRef.current;
      if (savedDateRef.current !== selectedDate || loadedDateRef.current !== selectedDate) {
        throw new Error('Tarih değişirken test kaydı oluşturulamaz. Tekrar deneyin.');
      }
      const stamp = Date.now();
      const testRecords = Array.from({ length: count }, (_, i) => {
        const table = data.tables[i % data.tables.length];
        const minutes = 10 * 60 + (i * 7) % (12 * 60);
        return {
          id: `test_reserva_${stamp}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          testData: true,
          date: selectedDate,
          areaId: table.areaId,
          tableNumber: String(table.number),
          fullName: `TEST KAYDI ${String(i + 1).padStart(5, '0')}`,
          people: 1 + (i % Math.max(1, Math.min(8, Number(table.capacity) || 4))),
          phone: '',
          time: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
          status: i % 11 === 0 ? 'arrived' : 'approved',
          important: false,
          note: 'Performans testi için oluşturulmuş örnek kayıttır.',
        };
      });
      const nextSnapshot = { ...data, reservations: [...data.reservations, ...testRecords] };
      // Önce cihazdaki kaydı tamamla, sonra başarı mesajı ve listeyi göster.
      await persistAppState(savedDataRef.current, nextSnapshot, selectedDate);
      savedDataRef.current = nextSnapshot;
      savedDateRef.current = selectedDate;
      loadedDateRef.current = selectedDate;
      setData(nextSnapshot);
      setShowTableModal(false);
      setShowAllTables(false);
      setFilter('test');
      setSearch('');
      Alert.alert('Test verileri hazır', `${count} test rezervasyonu ${prettyDate(selectedDate)} tarihine eklendi. Üstteki Test Verisi filtresinde inceleyebilirsiniz.`);
    } catch (error) {
      Alert.alert('Test verisi oluşturulamadı', error?.message || String(error));
    } finally {
      setTestBusy(false);
    }
  };

  const requestTestDataDeletion = () => {
    if (!isAdmin || testBusy) return;
    setPendingDelete({
      type: 'testData',
      title: 'Tüm test verileri silinsin mi?',
      message: 'Uygulamadaki tüm tarihlerde yalnızca TEST KAYDI olarak işaretlenmiş örnek rezervasyonlar kalıcı olarak silinecek. Gerçek rezervasyonlar korunacak.',
    });
  };

  const saveUpcomingSettings = () => {
    const minutes = Number(upcomingMinutesInput);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) return Alert.alert('Geçersiz süre', '5 ile 240 dakika arasında bir değer girin.');
    setData((prev) => ({ ...prev, settings: { ...(prev.settings || {}), upcomingMinutes: minutes } }));
    Alert.alert('Kaydedildi', `Yaklaşan rezervasyon süresi ${minutes} dakika oldu.`);
  };

  const saveOverdueSettings = () => {
    const minutes = Number(overdueMinutesInput);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240 || minutes >= (data.settings?.autoCancelMinutes ?? 30)) return Alert.alert('Geçersiz süre', 'Gecikme 0 dakika veya daha fazla olmalı ve otomatik iptal süresinden küçük olmalıdır.');
    setData((prev) => ({ ...prev, settings: { ...(prev.settings || {}), overdueMinutes: minutes } }));
    Alert.alert('Kaydedildi', `Geciken rezervasyon başlangıcı ${minutes} dakika oldu.`);
  };

  const saveAutoCancelSettings = () => {
    const minutes = Number(autoCancelMinutesInput);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || minutes <= (data.settings?.overdueMinutes ?? 0)) {
      return Alert.alert('Geçersiz süre', 'Otomatik iptal süresi 1–240 dakika olmalı ve gecikme süresini geçmelidir.');
    }
    setData((prev) => ({ ...prev, settings: { ...prev.settings, autoCancelMinutes: minutes } }));
    Alert.alert('Kaydedildi', `Onaylı rezervasyonlar ${minutes} dakika sonra otomatik İptal durumuna geçecek.`);
  };

  const saveCapacityFilterSettings = () => {
    const ranges = parseCapacityRanges(capacityValuesInput);
    if (!ranges) return Alert.alert('Hatalı kapasite aralığı', '1–99 arasında en fazla 10 aralık girin. Örnek: 2, 4-5, 6-10');
    setData((prev) => ({ ...prev, settings: { ...prev.settings, capacityFilterRanges: ranges } }));
    setCapacityFilterIndex(-1);
    Alert.alert('Kaydedildi', 'Masa kapasitesi aralıkları güncellendi.');
  };

  const setCapacityFeature = (enabled) => {
    setData((prev) => ({ ...prev, settings: { ...prev.settings, capacityFilterEnabled: enabled } }));
    setCapacityFilterIndex(-1);
  };

  // Hostesin yeni rezervasyonda görebileceği uygun, boş masalar.
  const availableNewTables = (areaId, peopleValue) => {
    // Guest count may be different from table capacity; hide only occupied tables.
    return areaTables(areaId).filter((table) =>
      !firstActiveReservationByTable.has(`${areaId}::${tableKey(table.number)}`));
  };

  const openNewReservation = (presetAreaId, presetTableNumber) => {
    const areaId = presetAreaId || data.areas[0]?.id || '';
    const hasPreset = presetAreaId && presetTableNumber !== undefined && presetTableNumber !== null;
    setEditingReservation(null);
    setReservationPreset(hasPreset ? { areaId, tableNumber: String(presetTableNumber) } : null);
    setFormAreaId(areaId);
    const firstTable = availableNewTables(areaId, '')[0];
    setFormTable(hasPreset ? String(presetTableNumber) : (firstTable ? String(firstTable.number) : ''));
    setFormName('');
    setFormPeople('');
    setFormPhone('05');
    const area = data.areas.find((a) => a.id === areaId);
    setFormTime(area?.timedArea ? (area.defaultStartTime || '19:00') : '');
    setFormEndTime(area?.timedArea ? (area.defaultEndTime || '20:00') : '');
    if (area?.clockArea) setFormPhone('');
    setShowReservationModal(true);
  };

  const openEditReservation = (reservation) => {
    setEditingReservation(reservation);
    setReservationPreset(null);
    setFormAreaId(reservation.areaId);
    setFormTable(String(reservation.tableNumber));
    setFormName(reservation.fullName);
    setFormPeople(String(reservation.people));
    setFormPhone(reservation.phone || '');
    setFormTime(reservation.time || '19:00');
    const area = data.areas.find((a) => a.id === reservation.areaId);
    setFormEndTime(area?.clockArea ? (reservation.endTime || '') : (area?.timedArea ? (reservation.endTime || area.defaultEndTime || '20:00') : ''));
    setMenuReservation(null);
    setShowReservationModal(true);
  };

  const closeReservationModal = () => {
    setShowReservationModal(false);
    setReservationPreset(null);
    setEditingReservation(null);
  };

  const saveReservation = () => {
    const tableNumber = String(formTable).trim();
    const people = Number(formPeople);
    if (!formAreaId || !formName.trim() || !tableNumber || !Number.isInteger(people) || people < 1) {
      return Alert.alert('Eksik bilgi', 'Masa, ad soyad ve kişi sayısını kontrol edin.');
    }
    const currentArea = data.areas.find((a) => a.id === formAreaId);
    const parsedEndTime = currentArea?.timedArea || currentArea?.clockArea ? parseReservationTime(formEndTime) : null;
    const parsedTime = currentArea?.clockArea ? parsedEndTime : parseReservationTime(formTime);
    if (!parsedTime) return Alert.alert('Saat hatalı', currentArea?.clockArea ? 'Saatli Masa için kalkış saatini girin (ör. 20:00).' : 'Saati 19:30, 19.30, 19-30 veya 1930 olarak girin.');
    if ((currentArea?.timedArea || currentArea?.clockArea) && !parsedEndTime) {
      return Alert.alert('Kalkış saati gerekli', 'Bu alanda geçerli bir kalkış saati yazın.');
    }
    if (currentArea?.timedArea && parsedEndTime && parsedEndTime.minutes === parsedTime.minutes) {
      return Alert.alert('Saatleri kontrol edin', 'Geliş ve kalkış saatleri aynı olamaz.');
    }
    const table = getTable(formAreaId, tableNumber);
    if (!editingReservation && !availableNewTables(formAreaId, formPeople).some((t) => t.id === table?.id)) return Alert.alert('Masa dolu', 'Yalnızca boş bir masa seçebilirsiniz.');
    if (!table) return Alert.alert('Masa bulunamadı', 'Yönetim bölümünden önce masayı oluşturun.');
    const patch = {
      date: selectedDate,
      ...(!editingReservation ? { areaId: formAreaId, tableNumber } : {}),
      fullName: formName.trim(),
      people,
      phone: currentArea?.clockArea ? '' : formPhone.trim(),
      time: `${pad(parsedTime.hour)}:${pad(parsedTime.minute)}`,
      endTime: parsedEndTime ? `${pad(parsedEndTime.hour)}:${pad(parsedEndTime.minute)}` : '',
    };
    if (editingReservation) {
      updateReservation(editingReservation.id, patch);
      if (currentArea?.clockArea) scheduleClockAlert({ ...editingReservation, ...patch });
      else cancelClockAlert(editingReservation.id);
    } else {
      const newlyAddedId = id('reservation');
      setData((prev) => {
        const chosen = prev.tables.find((t) => t.areaId === formAreaId && tableKey(t.number) === tableKey(tableNumber));
        const inheritedNote = noteForDay(chosen, selectedDate);
        return {
          ...prev,
          tables: inheritedNote ? prev.tables.map((t) => t.id === chosen?.id ? withDayNote(t, selectedDate, '') : t) : prev.tables,
          reservations: [...prev.reservations, { id: newlyAddedId, ...patch, status: 'approved', important: false, note: inheritedNote }],
        };
      });
      if (currentArea?.clockArea) scheduleClockAlert({ id: newlyAddedId, ...patch, status: 'approved' });
    }
    closeReservationModal();
  };

  // Sadece 'Misafiri Geldi' oturtulan masa sorar; normal Geldi sormaz.
  const beginArrival = (reservation) => {
    setSeatedTableInput(String(reservation.seatedTable || ''));
    setArrivalReservation(reservation);
    setMenuReservation(null);
  };

  const confirmArrival = () => {
    if (!arrivalReservation) return;
    const seatedTable = seatedTableInput.trim();
    if (!seatedTable) {
      Alert.alert('Alınan masa gerekli', 'Misafirin oturtulduğu masa numarasını yazın.');
      return;
    }
    if (seatedTable.length > 40) {
      Alert.alert('Masa adı çok uzun', 'En fazla 40 karakter girin.');
      return;
    }
    updateReservation(arrivalReservation.id, { status: 'arrived', seatedTable, guestArrived: true, autoCancelled: false });
    setArrivalReservation(null);
    setSeatedTableInput('');
    setShowAllTables(true);
    setFilter('all');
  };

  const openReservationMenu = (reservation) => {
    setMenuReservation(reservation);
    setNoteDraft(reservation.note || '');
  };

  const openTableNote = (table, reservation = null) => {
    if (!table) return;
    const active = reservation || firstActiveReservationByTable.get(`${table.areaId}::${tableKey(table.number)}`);
    setNoteTable(table);
    setNoteReservationId(active?.id || null);
    setNoteDraft(active ? String(active.note || '') : noteForDay(table, selectedDate));
    setMenuReservation(null);
  };

  const commitTableNote = (text) => {
    if (!noteTable) return;
    const note = String(text || '').trim().slice(0, 200);
    const noteId = noteReservationId;
    const tableId = noteTable.id;
    const dateKey = selectedDate;
    setData((prev) => ({
      ...prev,
      reservations: noteId ? prev.reservations.map((r) => r.id === noteId ? { ...r, note } : r) : prev.reservations,
      tables: noteId && !prev.tables.some((t) => t.id === tableId && noteForDay(t, dateKey))
        ? prev.tables
        : prev.tables.map((t) => t.id === tableId ? withDayNote(t, dateKey, noteId ? '' : note) : t),
    }));
    setNoteTable(null);
    setNoteReservationId(null);
    setNoteDraft('');
    Keyboard.dismiss();
  };
  const saveTableNote = () => commitTableNote(noteDraft);
  const clearTableNote = () => commitTableNote('');

  const availableMoveTables = (areaId, reservation) => {
    if (!reservation) return [];
    const occupied = new Set(
      data.reservations
        .filter((r) => r.id !== reservation.id && r.date === reservation.date && r.areaId === areaId && r.status !== 'cancelled')
        .map((r) => tableKey(r.tableNumber))
    );
    return areaTables(areaId).filter((table) => !occupied.has(tableKey(table.number)) && !(areaId === reservation.areaId && tableKey(table.number) === tableKey(reservation.tableNumber)));
  };

  const openMoveReservation = (reservation) => {
    setMoveReservation(reservation);
    setMoveAreaId(reservation.areaId);
    setMoveTableNumber('');
    setMenuReservation(null);
  };

  const confirmMoveReservation = () => {
    if (!moveReservation || !moveAreaId || !moveTableNumber) return Alert.alert('Masa seçin');
    const valid = availableMoveTables(moveAreaId, moveReservation).some((t) => tableKey(t.number) === tableKey(moveTableNumber));
    if (!valid) return Alert.alert('Masa uygun değil');
    const destination = data.areas.find((a) => a.id === moveAreaId);
    const newEndTime = destination?.clockArea ? (moveReservation.endTime || moveReservation.time)
      : destination?.timedArea ? (moveReservation.endTime || destination.defaultEndTime || '20:00') : '';
    const patch = {
      areaId: moveAreaId,
      tableNumber: String(moveTableNumber),
      time: destination?.clockArea ? newEndTime : moveReservation.time,
      endTime: newEndTime,
    };
    updateReservation(moveReservation.id, patch);
    if (destination?.clockArea) scheduleClockAlert({ ...moveReservation, ...patch });
    else cancelClockAlert(moveReservation.id);
    setMoveReservation(null);
  };

  const requestDeleteReservation = (reservation) => {
    setMenuReservation(null);
    setPendingDelete({
      type: 'reservation', reservation,
      title: 'Rezervasyon silinsin mi?',
      message: `${tableLabel(reservation.tableNumber, true)} · ${reservation.fullName} rezervasyonu silinecek ve masa boşalacak.`,
    });
  };

  // Quick-operations panel is a virtual area, NOT a new table category or normal area.
  // Entries stay date-specific in local metadata and never modify real reservations.
  // Operasyonel kuyruklar gece yarısında kaybolmaz; Kalktı / Alındı ile temizlenir.
  const quickClockToday = data.settings?.quickClockEntries || [];
  const waitingToday = data.settings?.waitingEntries || [];
  const quickClockIsLate = (entry) => isClockReservationLate({ ...entry, time: entry.endTime, status: 'approved' }, now);

  const addQuickClockEntry = () => {
    const number = quickClockNumber.trim();
    const parsed = parseReservationTime(quickClockEndTime);
    if (!number) return Alert.alert('Masa numarası gerekli', 'Saatli Masa için masa numarasını yaz.');
    if (!parsed) return Alert.alert('Kalkış saati hatalı', 'Saat biçimi 20:00, 20.00, 20-00 veya 2000 olabilir.');
    if (quickClockToday.some((entry) => tableKey(entry.tableNumber) === tableKey(number))) {
      return Alert.alert('Masa zaten listede', 'Bu masa için önce Kalktı işlemini yap.');
    }
    const entry = { id: id('quick_clock'), date: selectedDate, areaId: QUICK_CLOCK_AREA_ID, tableNumber: number,
      endTime: `${pad(parsed.hour)}:${pad(parsed.minute)}`, createdAt: Date.now(), status: 'approved' };
    setData((prev) => ({ ...prev, settings: { ...prev.settings, quickClockEntries: [...(prev.settings.quickClockEntries || []), entry] } }));
    scheduleClockAlert(entry, { askPermission: true });
    setQuickClockNumber(''); setQuickClockEndTime(''); setShowQuickClockModal(false);
  };
  const removeQuickClockEntry = (entry) => {
    cancelClockAlert(entry.id);
    setData((prev) => ({ ...prev, settings: { ...prev.settings,
      quickClockEntries: (prev.settings.quickClockEntries || []).filter((item) => item.id !== entry.id) } }));
  };
  const addWaitingEntry = () => {
    const fullName = waitingName.trim().replace(/\s+/g, ' ');
    if (fullName.split(' ').filter(Boolean).length < 2) return Alert.alert('Ad soyad gerekli', 'Bekleyen misafirin adını ve soyadını gir.');
    setData((prev) => ({ ...prev, settings: { ...prev.settings,
      waitingEntries: [...(prev.settings.waitingEntries || []), { id: id('wait'), date: selectedDate, fullName, createdAt: Date.now() }] } }));
    setWaitingName(''); setShowWaitingModal(false);
  };
  const removeWaitingEntry = (entry) => {
    setData((prev) => ({ ...prev, settings: { ...prev.settings,
      waitingEntries: (prev.settings.waitingEntries || []).filter((item) => item.id !== entry.id) } }));
  };

  const selectedFormTable = getTable(formAreaId, formTable);
  const selectedFormArea = data.areas.find((area) => area.id === formAreaId);

  const AreaSelector = ({ onChange }) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectScroller}>
      {data.areas.filter((area) => !area.clockArea).map((area) => (
        <Pressable
          key={area.id}
          onPress={() => {
            setBulkAreaId(area.id);
            setNewTableCategoryId('');
            onChange?.(area.id);
          }}
          style={[styles.selectChip, bulkAreaId === area.id && styles.selectChipActive]}
        >
          <Text style={[styles.selectChipText, bulkAreaId === area.id && styles.selectChipTextActive]}>{area.name}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />

      {storageError ? <Pressable onPress={() => Alert.alert('Veri kaydetme sorunu', storageError)} style={{ backgroundColor: '#FEE4E2', padding: 8, borderBottomWidth: 1, borderColor: '#FDA29B' }}><Text style={{ color: '#B42318', textAlign: 'center', fontWeight: '800' }}>{storageError}</Text></Pressable> : null}

      <View style={[styles.header, compactHeader && styles.headerCompact, { paddingHorizontal: pagePadding, paddingVertical: Math.max(6, Math.round(9 * uiScale)) }]}>
        <Logo />
        <View style={[styles.datePickerWrap, compactHeader && styles.datePickerWrapCompact]}>
          <Pressable style={styles.dateArrow} onPress={() => navigateToDate(shiftDate(selectedDate, -1))}><Text style={styles.dateArrowText}>‹</Text></Pressable>
          <Pressable style={styles.dateCenter} onPress={() => navigateToDate(toDateKey(new Date()))}>
            <Text style={styles.calendarGlyph}>▣</Text>
            <View><Text style={styles.dateText}>{prettyDate(selectedDate)}</Text><Text style={styles.weekdayText}>{weekday(selectedDate)}</Text></View>
          </Pressable>
          <Pressable style={styles.dateArrow} onPress={() => navigateToDate(shiftDate(selectedDate, 1))}><Text style={styles.dateArrowText}>›</Text></Pressable>
        </View>
        <View style={[styles.headerActions, compactHeader && styles.headerActionsCompact]}>
          <View style={styles.searchWrap}>
            <Text style={styles.searchGlyph}>⌕</Text>
            <TextInput style={styles.searchInput} value={search} onChangeText={setSearch} placeholder="İsim, telefon veya masa ara..." placeholderTextColor="#98A2B3" autoCorrect={false} />
            {!!search && <Pressable accessibilityRole="button" accessibilityLabel="Aramadan çık, tüm masalara dön" style={styles.searchClearButton} onPress={() => { Keyboard.dismiss(); setSearch(''); setShowAllTables(true); setFilter('all'); setCapacityFilterIndex(-1); }}><Text style={styles.searchClearText}>×</Text></Pressable>}
          </View>
          {isAdmin ? (
            <Pressable style={styles.secondaryButton} onPress={openManagement}><Text style={styles.secondaryButtonText}>Yönetim</Text></Pressable>
          ) : (
            <Pressable style={styles.adminLoginButton} onPress={() => { setAdminError(''); setShowAdminLogin(true); }}><Text style={styles.adminLoginButtonText}>Yönetici Girişi</Text></Pressable>
          )}
          <Pressable style={styles.primaryButton} onPress={() => openNewReservation()}><Text style={styles.primaryButtonText}>＋ Rezervasyon</Text></Pressable>
        </View>
      </View>

      <View style={[styles.toolbar, { paddingHorizontal: pagePadding, minHeight: Math.max(48, Math.round(56 * uiScale)) }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow} style={{ flex: 1 }}>
          <Chip active={showAllTables && filter === 'all'} label="Tüm Masalar" count={data.tables.length} onPress={() => { setShowAllTables(true); setFilter('all'); }} />
          <Chip active={!showAllTables && filter === 'all'} label="Tümü" count={counts.all} onPress={() => { setShowAllTables(false); setFilter('all'); }} />
          <Chip active={filter === 'empty'} label="Boş Masalar" count={counts.empty} onPress={() => { setShowAllTables(false); setFilter('empty'); }} />
          {isAdmin && <Chip active={filter === 'test'} label="Test Verisi" count={counts.test} onPress={() => { setShowAllTables(false); setFilter('test'); }} />}
          <Chip active={filter === 'upcoming'} label="Yaklaşan" count={counts.upcoming} onPress={() => { setNow(new Date()); setShowAllTables(false); setFilter('upcoming'); }} />
          <Chip active={filter === 'overdue'} label="Geciken" count={counts.overdue} onPress={() => { setNow(new Date()); setShowAllTables(false); setFilter('overdue'); }} />
          <Chip active={filter === 'important'} label="Önemli" count={counts.important} onPress={() => { setShowAllTables(false); setFilter('important'); }} />
          <Chip active={filter === 'arrived'} label="Geldi" count={counts.arrived} onPress={() => { setShowAllTables(false); setFilter('arrived'); }} />
          <Chip active={filter === 'cancelled'} label="İptal" count={counts.cancelled} onPress={() => { setShowAllTables(false); setFilter('cancelled'); }} />
        </ScrollView>
        {showAllTables && filter === 'all' && data.settings?.capacityFilterEnabled !== false && (
          <View style={styles.capacityToolbar}>
            <Pressable style={[styles.capacityCycleButton, currentCapacity !== null && styles.capacityCycleButtonActive]}
              onPress={() => setCapacityFilterIndex((prev) => (prev + 1) % capacityOptions.length)}>
              <Text style={[styles.capacityCycleText, currentCapacity !== null && styles.capacityCycleTextActive]}>{currentCapacity === null ? '▤ Filtrele' : capacityRangeLabel(currentCapacity)}</Text>
            </Pressable>
            {currentCapacity !== null && <Pressable accessibilityLabel="Kapasite filtresini kaldır" style={styles.capacityClearButton} onPress={() => setCapacityFilterIndex(-1)}><Text style={styles.capacityClearText}>×</Text></Pressable>}
          </View>
        )}
      </View>

      {(() => {
        const clockLateReservations = selectedDate === toDateKey(now)
          ? todaysReservations.filter((r) => clockLate(r)) : [];
        const signature = `clock:${selectedDate}:${clockLateReservations.map((r) => r.id).sort().join(',')}`;
        if (!clockLateReservations.length || dismissedLateAlerts[signature]) return null;
        return (
          <View style={styles.clockAlertBanner}>
            <Pressable style={styles.clockAlertBannerBody} onPress={() => { setShowAllTables(false); setFilter('overdue'); }}>
              <Text numberOfLines={1} style={styles.clockAlertBannerText}>⏰ Saatli Masa Gecikti — {clockLateReservations.length} masa kalkış saatini geçti. Görmek için dokun.</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Gecikme uyarısını kapat" hitSlop={8} style={styles.clockAlertClose}
              onPress={() => setDismissedLateAlerts((prev) => ({ ...prev, [signature]: true }))}>
              <Text style={styles.clockAlertCloseText}>×</Text>
            </Pressable>
          </View>
        );
      })()}

      {(() => {
        if (!showQuickPanels || !quickLateCount) return null;
        const active = (data.settings?.quickClockEntries || [])
          .filter((entry) => isClockReservationLate({ ...entry, time: entry.endTime, status: 'approved' }, now))
          .map((entry) => entry.id).sort();
        const signature = `quick:${selectedDate}:${active.join(',')}`;
        if (dismissedLateAlerts[signature]) return null;
        return (
          <View style={styles.clockAlertBanner}>
            <Pressable style={styles.clockAlertBannerBody} onPress={() => areaPagerRef.current?.scrollToEnd({ animated: true })}>
              <Text numberOfLines={1} style={styles.clockAlertBannerText}>⏰ Saatli Masa: {quickLateCount} masa gecikti — listeye gitmek için dokun.</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Saatli masa uyarısını kapat" hitSlop={8} style={styles.clockAlertClose}
              onPress={() => setDismissedLateAlerts((prev) => ({ ...prev, [signature]: true }))}>
              <Text style={styles.clockAlertCloseText}>×</Text>
            </Pressable>
          </View>
        );
      })()}

      <CachedReservationBoard signature={areaListExtraData}>
      <FlatList
        // Dış liste yatay: Android'de iç içe dikey FlatList'ler birbirinin
        // kaydırmasını engelliyordu. Salon/Bahçe aynı anda yan yana görünür;
        // 3+ alan eklenirse diğer alanlara yatay kaydırılarak ulaşılır.
        horizontal
        ref={areaPagerRef}
        snapToInterval={areaCardWidth + areaGap}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        style={styles.areaScroller}
        onLayout={(event) => {
          const height = Math.round(event.nativeEvent.layout.height);
          if (height > 0) setAreaViewportHeight((previous) => previous === height ? previous : height);
        }}
        data={boardAreas}
        keyExtractor={(area) => area.id}
        scrollEnabled={!tableDragActive && boardAreas.length > 2}
        showsHorizontalScrollIndicator={boardAreas.length > 2}
        removeClippedSubviews={false}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={3}
        extraData={areaListExtraData}
        contentContainerStyle={{ paddingHorizontal: pagePadding, paddingBottom: pagePadding, gap: areaGap }}
        renderItem={({ item: area }) => {
          if (area.id === OPTIONAL_AREA_ID) {
            const panelGap = 7;
            const quickRowHeight = Math.max(43, Math.round(49 * uiScale));
            return (
              <View style={[styles.areaCard, styles.quickAreaCard, { width: areaCardWidth, height: areaCardHeight }]}>
                <View style={styles.quickSplitRow}>
                  <View style={[styles.quickHalfPanel, { marginRight: panelGap / 2 }]}>
                    <View style={styles.quickPanelHeader}><Text style={styles.quickPanelTitle}>Saatli Masa</Text><Text style={styles.quickPanelCount}>{quickClockToday.length}</Text></View>
                    <Text style={styles.quickPanelCaption}>Masa numarası · Kalkış saati</Text>
                    <FlatList
                      data={quickClockToday}
                      keyExtractor={(entry) => entry.id}
                      nestedScrollEnabled
                      style={styles.quickPanelList}
                      contentContainerStyle={styles.quickPanelListContent}
                      keyboardShouldPersistTaps="handled"
                      ListEmptyComponent={<Text style={styles.quickPanelEmpty}>Henüz saatli masa yok</Text>}
                      renderItem={({ item: entry }) => {
                        const late = quickClockIsLate(entry);
                        return (
                          <View style={[styles.quickListRow, { minHeight: quickRowHeight }, late && styles.quickLateRow]}>
                            <View style={styles.quickRowTextWrap}>
                              <Text numberOfLines={1} style={styles.quickRowName}>Masa {entry.tableNumber}</Text>
                              <Text style={[styles.quickRowMeta, late && styles.quickLateText]}>{late ? 'Gecikti · ' : 'Kalkış · '}{entry.endTime}</Text>
                            </View>
                            <Pressable onPress={() => removeQuickClockEntry(entry)} accessibilityRole="button" accessibilityLabel={`Masa ${entry.tableNumber} kalktı`} style={styles.quickDoneButton}><Text style={styles.quickDoneText}>Kalktı</Text></Pressable>
                          </View>
                        );
                      }}
                    />
                    <Pressable accessibilityRole="button" accessibilityLabel="Saatli masa ekle" onPress={() => { setQuickClockNumber(''); setQuickClockEndTime(''); setShowQuickClockModal(true); }} style={styles.quickAddRow}>
                      <View style={styles.quickAddIcon}><View style={styles.plusHorizontal} /><View style={styles.plusVertical} /></View>
                    </Pressable>
                  </View>
                  <View style={[styles.quickHalfPanel, { marginLeft: panelGap / 2 }]}>
                    <View style={styles.quickPanelHeader}><Text style={styles.quickPanelTitle}>Bekleyen Listesi</Text><Text style={styles.quickPanelCount}>{waitingToday.length}</Text></View>
                    <Text style={styles.quickPanelCaption}>Geliş sırasına göre</Text>
                    <FlatList
                      data={waitingToday}
                      keyExtractor={(entry) => entry.id}
                      nestedScrollEnabled
                      style={styles.quickPanelList}
                      contentContainerStyle={styles.quickPanelListContent}
                      keyboardShouldPersistTaps="handled"
                      ListEmptyComponent={<Text style={styles.quickPanelEmpty}>Bekleyen misafir yok</Text>}
                      renderItem={({ item: entry, index }) => (
                        <View style={[styles.quickListRow, { minHeight: quickRowHeight }]}>
                          <View style={styles.quickRowTextWrap}><Text numberOfLines={1} style={styles.quickRowName}>{index + 1}. {entry.fullName}</Text></View>
                          <Pressable onPress={() => removeWaitingEntry(entry)} accessibilityRole="button" accessibilityLabel={`${entry.fullName} alındı`} style={[styles.quickDoneButton, styles.quickTakenButton]}><Text style={styles.quickDoneText}>Alındı</Text></Pressable>
                        </View>
                      )}
                    />
                    <Pressable accessibilityRole="button" accessibilityLabel="Bekleyen misafir ekle" onPress={() => { setWaitingName(''); setShowWaitingModal(true); }} style={styles.quickAddRow}>
                      <View style={styles.quickAddIcon}><View style={styles.plusHorizontal} /><View style={styles.plusVertical} /></View>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          }
          const groups = buildAreaGroups(area.id);
          const rowHeight = Math.max(44, Math.round(49 * uiScale));
          const rowGap = Math.max(2, Math.round(3 * uiScale));
          const rowStride = rowHeight + rowGap;
          const flatRows = groups.flatMap((group) => [
            ...(group.label ? [{ type: 'divider', key: `divider_${group.id}`, group }] : []),
            ...group.rows.map((row, rowIndex) => ({ type: 'table', key: `${group.id}_${row.kind === 'empty' ? row.table.id : row.reservation.id}`, group, row, rowIndex })),
          ]);
          return (
            <View key={area.id} style={[styles.areaCard, { width: areaCardWidth, height: areaCardHeight }]}>
              <View style={styles.areaHeaderCompact}>
                <Text style={[styles.areaTitle, { fontSize: Math.max(15, Math.round(19 * uiScale)) }]}>{area.name}</Text>
                <View style={styles.legendWrapCompact}>
                  <Text style={styles.legendMasa}>Masa</Text>
                  <Text style={styles.legendName}>Ad Soyad</Text>
                  <Text style={styles.legendTime}>{area.clockArea ? 'Kalkış' : 'Saat'}</Text>
                  <Text style={styles.legendPeople}>Kişi</Text>
                  <Text style={styles.legendPhone}>Telefon</Text>
                  <Text style={styles.legendStatus}>Durum</Text>
                  <View style={styles.legendActions} />
                </View>
              </View>

              <FlatList
                nestedScrollEnabled
                scrollEnabled={!tableDragActive}
                removeClippedSubviews={Platform.OS === 'android' && !tableDragActive}
                initialNumToRender={10}
                maxToRenderPerBatch={8}
                windowSize={4}
                updateCellsBatchingPeriod={16}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                style={{ flex: 1 }}
                contentContainerStyle={styles.compactRowsWrap}
                data={flatRows}
                keyExtractor={(item) => item.key}
                extraData={areaListExtraData}
                ListEmptyComponent={<View style={styles.emptyState}><Text style={styles.emptyIcon}>⌁</Text><Text style={styles.emptyTitle}>Kayıt yok</Text><Text style={styles.emptyText}>Bu alan ve filtre için kayıt bulunamadı.</Text></View>}
                renderItem={({ item }) => {
                  const { group } = item;
                  if (item.type === 'divider') return (
                    <View style={styles.categoryDivider}>
                      <View style={styles.categoryLine} />
                      <Text style={styles.categoryDividerText}>{group.label}</Text>
                      <View style={styles.categoryLine} />
                    </View>
                  );
                  const { row, rowIndex } = item;
                  const groupDrag = dragPreview?.areaId === area.id && dragPreview?.groupId === group.id ? dragPreview : null;
                  const shiftForRow = (index) => {
                    if (!groupDrag || groupDrag.fromIndex === groupDrag.hoverIndex || index === groupDrag.fromIndex) return 0;
                    if (groupDrag.hoverIndex > groupDrag.fromIndex && index > groupDrag.fromIndex && index <= groupDrag.hoverIndex) return -rowStride;
                    if (groupDrag.hoverIndex < groupDrag.fromIndex && index < groupDrag.fromIndex && index >= groupDrag.hoverIndex) return rowStride;
                    return 0;
                  };
                  const dragEnabled = isAdmin && showAllTables && filter === 'all' && currentCapacity === null && !search.trim();
                  const commonDragProps = {
                    enabled: dragEnabled,
                    index: rowIndex,
                    rowStride,
                    rowCount: group.rows.length,
                    shiftOffset: shiftForRow(rowIndex),
                    onDragStart: (from) => { setTableDragActive(true); setDragPreview({ areaId: area.id, groupId: group.id, categoryId: group.categoryId, fromIndex: from, hoverIndex: from }); },
                    onDragHover: (to) => setDragPreview((prev) => prev?.areaId === area.id && prev?.groupId === group.id ? { ...prev, hoverIndex: to } : prev),
                    onDrop: (from, to) => { reorderTableWithinGroup(area.id, group.categoryId, from, to); setDragPreview(null); setTableDragActive(false); },
                  };
                        if (row.kind === 'empty') {
                          const table = row.table;
                          return (
                            <DraggableTableRow key={`empty_${table.id}`} {...commonDragProps} onPress={() => openNewReservation(area.id, table.number)} style={[styles.row, styles.emptyTableRow, { minHeight: rowHeight, marginBottom: rowGap }]}>
                              <View style={[styles.statusBar, { backgroundColor: '#D0D5DD' }]} />
                              <View style={styles.compactTableCell}><Text numberOfLines={1} style={styles.emptyTableNumber}>{table.number}</Text></View>
                              <View style={styles.compactNameCell}><Text numberOfLines={1} style={styles.emptyTableTitleMuted}>Boş Masa</Text>
                                {!!noteForDay(table, selectedDate) && <View style={styles.rowNoteBadge}><Text numberOfLines={1} style={styles.rowNoteText}>Not: {noteForDay(table, selectedDate)}</Text></View>}</View>
                              <View style={styles.compactTimeCell}><Text style={styles.emptyDashCompact}>—</Text></View>
                              <View style={styles.compactPeopleCell}><Text style={styles.emptyCapacityText}>{table.capacity || 4} max</Text></View>
                              <View style={styles.compactPhoneCell}><Text style={styles.emptyDashCompact}>—</Text></View>
                              <View style={styles.compactStatusCell}><Text style={styles.emptyDashCompact}>—</Text></View>
                              <View style={styles.compactActions}>
                                <Pressable accessibilityRole="button" accessibilityLabel="Masaya rezervasyon ekle"
                                  onPress={() => openNewReservation(area.id, table.number)} style={styles.emptyAddButtonCompact}>
                                  <View style={styles.plusHorizontal} /><View style={styles.plusVertical} />
                                </Pressable>
                              </View>
                            </DraggableTableRow>
                          );
                        }
                        const r = row.reservation;
                        const visibleNote = String(r.note || '').trim() || noteForDay(row.table, selectedDate);
                        return (
                          <DraggableTableRow key={r.id} {...commonDragProps} style={[styles.row, { minHeight: rowHeight, marginBottom: rowGap }, clockLate(r) && styles.clockOverdueRow, !clockLate(r) && r.status === 'arrived' && filter === 'all' && styles.arrivedSoftRow]}>
                            <View style={[styles.statusBar, { backgroundColor: clockLate(r) ? COLORS.red : (STATUS[r.status] || STATUS.approved).color }]} />
                            <View style={styles.compactTableCell}><Text numberOfLines={1} style={styles.compactTableNumber}>{r.tableNumber}</Text></View>
                            <View style={styles.compactNameCell}>
                              <Text numberOfLines={1} style={styles.compactNameText}>{r.fullName}</Text>
                              {!!visibleNote && <View style={styles.rowNoteBadge}><Text numberOfLines={1} style={styles.rowNoteText}>Not: {visibleNote}</Text></View>}
                            </View>
                            <View style={[styles.compactTimeCell, styles.shiftedTimeCell]}>
                              <Text style={styles.compactTimeText}>{clockAreaIds.has(r.areaId) ? (r.endTime || r.time) : r.time}</Text>
                              {!!(data.areas.find((a) => a.id === r.areaId)?.timedArea && r.endTime) && <Text style={styles.compactEndTimeText}>↳ {r.endTime}</Text>}
                            </View>
                            <View style={[styles.compactPeopleCell, styles.shiftedPeopleCell]}><Text style={styles.compactPeopleText}>♟ {r.people}px</Text></View>
                            <View style={styles.compactPhoneCell}><Text numberOfLines={1} style={styles.compactPhoneText}>{r.phone || '—'}</Text></View>
                            <View style={[styles.compactStatusCell, r.status === 'arrived' && !!r.seatedTable && styles.compactStatusWithSeatedTable]}>
                              {clockLate(r) ? <View style={styles.clockOverdueBadge}><Text style={styles.clockOverdueBadgeText}>Gecikti</Text></View> : r.status === 'arrived' && !!r.seatedTable ? (
                                <View style={styles.arrivalTag}><Text style={styles.arrivalTagText}>Geldi {r.seatedTable}</Text></View>
                              ) : <StatusBadge status={r.status} />}
                            </View>
                            <View style={styles.compactActions}>
                              <Pressable accessibilityRole="button" accessibilityLabel="Rezervasyon menüsü, düzenleme ve masa notu" onPress={() => openReservationMenu(r)} style={styles.moreButtonCompact}><Text style={styles.moreTextCompact}>✎</Text></Pressable>
                            </View>
                          </DraggableTableRow>
                        );
                }}
              />
            </View>
          );
        }}
      />
      </CachedReservationBoard>

      <ModalShell visible={showQuickClockModal} title="Saatli Masa Ekle" onClose={() => setShowQuickClockModal(false)} width={420} scrollable>
        <Field label="Masa Numarası" value={quickClockNumber} onChangeText={setQuickClockNumber} placeholder="Örn. 21" autoCapitalize="none" />
        <Field label="Kalkış Saati" value={quickClockEndTime} onChangeText={setQuickClockEndTime} placeholder="Örn. 20:00" autoCapitalize="none" />
        <View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setShowQuickClockModal(false)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={addQuickClockEntry}><Text style={styles.primaryButtonText}>Ekle</Text></Pressable></View>
      </ModalShell>
      <ModalShell visible={showWaitingModal} title="Bekleyen Misafir Ekle" onClose={() => setShowWaitingModal(false)} width={420} scrollable>
        <Field label="İsim Soyisim" value={waitingName} onChangeText={setWaitingName} placeholder="Örn. Ayşe Yılmaz" autoCapitalize="words" />
        <View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setShowWaitingModal(false)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={addWaitingEntry}><Text style={styles.primaryButtonText}>Ekle</Text></Pressable></View>
      </ModalShell>

      <ModalShell visible={showAdminLogin} title="Yönetici Girişi" onClose={() => setShowAdminLogin(false)} width={420} scrollable>
        <Field label="Kullanıcı adı" value={adminUsername} onChangeText={(v) => { setAdminUsername(v); setAdminError(''); }} placeholder="Kullanıcı adı" />
        <Field label="Şifre" value={adminPassword} onChangeText={(v) => { setAdminPassword(v); setAdminError(''); }} placeholder="Şifre" secureTextEntry />
        {adminError ? <Text style={styles.adminError}>{adminError}</Text> : null}
        <View style={styles.modalFooter}>
          <Pressable style={styles.cancelButton} onPress={() => setShowAdminLogin(false)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable>
          <Pressable style={styles.primaryButtonLarge} onPress={handleAdminLogin}><Text style={styles.primaryButtonText}>Giriş Yap</Text></Pressable>
        </View>
      </ModalShell>

      <ModalShell visible={showTableModal && isAdmin} title="Yönetim" onClose={() => setShowTableModal(false)} width={760} scrollable>
        <View style={styles.managementTabs}>
          {[['tables', 'Masalar'], ['areas', 'Alanlar'], ['categories', 'Kategoriler'], ['settings', 'Ayarlar']].map(([key, label]) => (
            <Pressable key={key} onPress={() => setManagementTab(key)} style={[styles.managementTab, managementTab === key && styles.managementTabActive]}>
              <Text style={[styles.managementTabText, managementTab === key && styles.managementTabTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {managementTab === 'areas' && (
          <View>
            <View style={styles.manageHeaderRow}><View><Text style={styles.sectionTitle}>Alan Yönetimi</Text><Text style={styles.modalTiny}>Alan ekleyin, adını değiştirin veya silin.</Text></View><Pressable style={styles.primaryButtonSmall} onPress={() => openAreaEditor()}><Text style={styles.primaryButtonText}>＋ Alan Ekle</Text></Pressable></View>
            <View style={styles.managementList}>
              {data.areas.map((area) => (
                <View key={area.id} style={styles.managementListRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.managementListTitle}>{area.name}</Text>
                    {area.timedArea && <Text style={styles.timedAreaMeta}>Erken Rezervasyon Alanı · {area.defaultStartTime || '19:00'}–{area.defaultEndTime || '20:00'}</Text>}
                    {area.clockArea && <Text style={styles.timedAreaMeta}>Önceki sürümden kalan saatli alan · kayıtlar korunur</Text>}
                  </View>
                  <View style={styles.managementRowActions}>
                    <Pressable style={styles.smallNeutralButton} onPress={() => openAreaEditor(area)}><Text style={styles.smallNeutralText}>Düzenle</Text></Pressable>
                    <Pressable style={styles.smallDangerButton} onPress={() => deleteArea(area)}><Text style={styles.smallDangerText}>Sil</Text></Pressable>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {managementTab === 'categories' && (
          <View>
            <Text style={styles.sectionTitle}>Kategori Yönetimi</Text>
            <Text style={styles.modalHelp}>Alan içinde masa grupları oluşturun. Ana listede kategoriler küçük bir ayırıcı çizgiyle gösterilir.</Text>
            <Text style={styles.fieldLabel}>Alan</Text>
            <AreaSelector />
            <View style={styles.singleTableCreateRow}>
              <View style={styles.singleTableField}><Field label="Kategori adı" value={newCategoryName} onChangeText={setNewCategoryName} placeholder="Örn. Pencere Önü, VIP, Arka Bölüm" /></View>
              <Pressable style={styles.singleTableAddButton} onPress={addCategory}><Text style={styles.primaryButtonText}>Kategori Ekle</Text></Pressable>
            </View>
            <View style={styles.managementList}>
              {areaCategories(bulkAreaId).length ? areaCategories(bulkAreaId).map((category) => (
                <View key={category.id} style={styles.managementListRow}>
                  <Text style={styles.managementListTitle}>{category.name}</Text>
                  <Text style={styles.managementListMeta}>{areaTables(bulkAreaId).filter((t) => t.categoryId === category.id).length} masa</Text>
                  <Pressable style={styles.smallDangerButton} onPress={() => deleteCategory(category)}><Text style={styles.smallDangerText}>Sil</Text></Pressable>
                </View>
              )) : <View style={styles.noTablesBox}><Text style={styles.noTablesText}>Bu alanda kategori yok.</Text></View>}
            </View>
          </View>
        )}

        {managementTab === 'tables' && (
          <View>
            <Text style={styles.sectionTitle}>Masa Yönetimi</Text>
            <Text style={styles.modalHelp}>Alan, kategori ve kapasite seçerek toplu veya tekli masa oluşturabilirsiniz.</Text>
            <Text style={styles.fieldLabel}>Alan</Text>
            <AreaSelector />
            <Text style={styles.fieldLabel}>Kategori</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectScroller}>
              <Pressable onPress={() => setNewTableCategoryId('')} style={[styles.selectChip, !newTableCategoryId && styles.selectChipActive]}><Text style={[styles.selectChipText, !newTableCategoryId && styles.selectChipTextActive]}>Kategorisiz</Text></Pressable>
              {areaCategories(bulkAreaId).map((category) => (
                <Pressable key={category.id} onPress={() => setNewTableCategoryId(category.id)} style={[styles.selectChip, newTableCategoryId === category.id && styles.selectChipActive]}><Text style={[styles.selectChipText, newTableCategoryId === category.id && styles.selectChipTextActive]}>{category.name}</Text></Pressable>
              ))}
            </ScrollView>
            <Field label="Masa kapasitesi" value={newTableCapacity} onChangeText={setNewTableCapacity} placeholder="4" keyboardType="number-pad" />

            <Text style={styles.sectionTitle}>Toplu masa oluştur</Text>
            <View style={styles.twoFields}>
              <Field style={styles.halfField} label="İlk masa" value={startTable} onChangeText={setStartTable} placeholder="1" keyboardType="number-pad" />
              <Field style={styles.halfField} label="Son masa" value={endTable} onChangeText={setEndTable} placeholder="80" keyboardType="number-pad" />
            </View>
            <Pressable style={styles.fullPrimaryButton} onPress={createTables}><Text style={styles.primaryButtonText}>Masaları Oluştur</Text></Pressable>

            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Tekli masa oluştur</Text>
            <View style={styles.singleTableCreateRow}>
              <View style={styles.singleTableField}><Field label="Masa adı / numarası" value={singleTableName} onChangeText={setSingleTableName} placeholder="Örn. Salon 1, VIP A" /></View>
              <Pressable style={styles.singleTableAddButton} onPress={createSingleTable}><Text style={styles.primaryButtonText}>Masa Ekle</Text></Pressable>
            </View>

            <View style={styles.manageDivider} />
            <View style={styles.manageHeaderRow}>
              <View><Text style={styles.sectionTitle}>Mevcut masalar</Text><Text style={styles.modalTiny}>{data.areas.find((a) => a.id === bulkAreaId)?.name || 'Alan'} · {areaTables(bulkAreaId).length} masa</Text></View>
              {areaTables(bulkAreaId).length > 0 && <Pressable style={styles.deleteAllTablesButton} onPress={deleteAllTablesInArea}><Text style={styles.deleteAllTablesText}>Tümünü Sil</Text></Pressable>}
            </View>
            <View style={styles.tableChipGrid}>
              {areaTables(bulkAreaId).map((table) => (
                <View key={table.id} style={styles.tableManageChipWide}>
                  <View style={{ flex: 1 }}><Text style={styles.tableManageText}>{tableLabel(table.number, true)}</Text><Text style={styles.tableManageMeta}>{table.capacity || 4} kişilik{table.categoryId ? ` · ${getCategory(table.categoryId)?.name || ''}` : ''}</Text></View>
                  <Pressable onPress={() => openTableEdit(table)} style={styles.tableEditButton}><Text style={styles.tableEditText}>Düzenle</Text></Pressable>
                  <Pressable onPress={() => deleteTable(table)} style={styles.tableDeleteButton}><Text style={styles.tableDeleteText}>× Sil</Text></Pressable>
                </View>
              ))}
            </View>
          </View>
        )}

        {managementTab === 'settings' && (
          <View>
            <Text style={styles.sectionTitle}>Opsiyonel Özellikler</Text>
            <Text style={styles.modalHelp}>Saatli Masa ve Bekleyen Listesi tek alanın iki yarısıdır. İkisi birlikte açılır veya kapanır. Kapatmak kayıtları silmez.</Text>
            <View style={styles.filterSettingsToggle}>
              <Text style={styles.settingToggleLabel}>Saatli Masa + Bekleyen Listesi</Text>
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: data.settings?.quickPanelsEnabled === true }}
                onPress={() => {
                  if (data.settings?.quickPanelsEnabled === true) {
                    (data.settings.quickClockEntries || []).forEach((entry) => cancelClockAlert(entry.id));
                  }
                  setData((prev) => ({ ...prev, settings: { ...prev.settings, quickPanelsEnabled: !prev.settings.quickPanelsEnabled } }));
                }}
                style={[styles.settingToggleButton, data.settings?.quickPanelsEnabled === true && styles.settingToggleActive]}>
                <Text style={[styles.settingToggleText, data.settings?.quickPanelsEnabled === true && { color: '#FFFFFF' }]}>{data.settings?.quickPanelsEnabled === true ? 'Açık' : 'Kapalı'}</Text>
              </Pressable>
            </View>
            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Yaklaşan Rezervasyon Süresi</Text>
            <Text style={styles.modalHelp}>Yaklaşan sekmesinde şu andan itibaren kaç dakika içindeki rezervasyonların gösterileceğini belirleyin.</Text>
            <Field label="Süre (dakika)" value={upcomingMinutesInput} onChangeText={setUpcomingMinutesInput} placeholder="30" keyboardType="number-pad" />
            <View style={styles.quickTimeRow}>{[15, 30, 45, 60].map((minutes) => <Pressable key={minutes} onPress={() => setUpcomingMinutesInput(String(minutes))} style={[styles.quickTimeChip, Number(upcomingMinutesInput) === minutes && styles.quickTimeChipActive]}><Text style={[styles.quickTimeChipText, Number(upcomingMinutesInput) === minutes && styles.quickTimeChipTextActive]}>{minutes} dk</Text></Pressable>)}</View>
            <Pressable style={styles.fullPrimaryButton} onPress={saveUpcomingSettings}><Text style={styles.primaryButtonText}>Yaklaşan Süresini Kaydet</Text></Pressable>
            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Geciken Rezervasyon Süresi</Text>
            <Text style={styles.modalHelp}>0 dakika seçildiğinde rezervasyon saati geçtiği anda Geciken bölümünde görünür. Bu süre İptal süresinden küçük olmalıdır.</Text>
            <Field label="Gecikme alt sınırı (dakika)" value={overdueMinutesInput} onChangeText={setOverdueMinutesInput} placeholder="0" keyboardType="number-pad" />
            <View style={styles.quickTimeRow}>{[0, 5, 10, 15].map((minutes) => <Pressable key={minutes} onPress={() => setOverdueMinutesInput(String(minutes))} style={[styles.quickTimeChip, Number(overdueMinutesInput) === minutes && styles.quickTimeChipActive]}><Text style={[styles.quickTimeChipText, Number(overdueMinutesInput) === minutes && styles.quickTimeChipTextActive]}>{minutes} dk</Text></Pressable>)}</View>
            <Pressable style={styles.fullPrimaryButton} onPress={saveOverdueSettings}><Text style={styles.primaryButtonText}>Gecikme Süresini Kaydet</Text></Pressable>
            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Otomatik İptal Süresi</Text>
            <Text style={styles.modalHelp}>Misafir gelmediyse ve rezervasyon saati bu kadar dakika geçtiyse rezervasyon İptal durumuna alınır. Örnek: 30 dk.</Text>
            <Field label="Otomatik iptal (dakika)" value={autoCancelMinutesInput} onChangeText={setAutoCancelMinutesInput} placeholder="30" keyboardType="number-pad" />
            <View style={styles.quickTimeRow}>{[15, 30, 45, 60].map((minutes) => <Pressable key={minutes} onPress={() => setAutoCancelMinutesInput(String(minutes))} style={[styles.quickTimeChip, Number(autoCancelMinutesInput) === minutes && styles.quickTimeChipActive]}><Text style={[styles.quickTimeChipText, Number(autoCancelMinutesInput) === minutes && styles.quickTimeChipTextActive]}>{minutes} dk</Text></Pressable>)}</View>
            <Pressable style={styles.fullPrimaryButton} onPress={saveAutoCancelSettings}><Text style={styles.primaryButtonText}>İptal Süresini Kaydet</Text></Pressable>
            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Masa Kapasitesi Filtresi</Text>
            <Text style={styles.modalHelp}>Tüm Masalar ekranında kapasite aralıkları sırayla dolaşılır. Örneğin 4-5 kişi ve 6-10 kişi.</Text>
            <View style={styles.filterSettingsToggle}>
              <Text style={styles.settingToggleLabel}>{data.settings?.capacityFilterEnabled !== false ? 'Filtre Aktif' : 'Filtre Kapalı'}</Text>
              <Pressable onPress={() => setCapacityFeature(data.settings?.capacityFilterEnabled === false)} style={[styles.settingToggleButton, data.settings?.capacityFilterEnabled !== false && styles.settingToggleActive]}>
                <Text style={[styles.settingToggleText, data.settings?.capacityFilterEnabled !== false && {color:'#FFFFFF'}]}>{data.settings?.capacityFilterEnabled !== false ? 'Açık' : 'Kapalı'}</Text>
              </Pressable>
            </View>
            <Field label="Kişi kapasitesi aralıkları (virgülle ayırın)" value={capacityValuesInput} onChangeText={setCapacityValuesInput} placeholder="2, 4-5, 6-10" keyboardType="default" />
            <Pressable style={styles.fullPrimaryButton} onPress={saveCapacityFilterSettings}><Text style={styles.primaryButtonText}>Kapasite Filtrelerini Kaydet</Text></Pressable>
            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Geçmiş Rezervasyon Temizliği</Text>
            <Text style={styles.modalHelp}>Yalnızca rezervasyon bulunan geçmiş tarihler listelenir. İstediğiniz günleri tek tek veya topluca silebilirsiniz. Bugünkü ve gelecek rezervasyonlar etkilenmez.</Text>
            <Pressable style={styles.fullPrimaryButton} onPress={openHistoryManager}>
              <Text style={styles.primaryButtonText}>Geçmiş Günleri Gör ve Yönet</Text>
            </Pressable>
            <View style={styles.manageDivider} />
            <Text style={styles.sectionTitle}>Performans Testi · Test Verileri</Text>
            <Text style={styles.modalHelp}>Seçili tarih: {prettyDate(selectedDate)}. Örnek kayıtlar yalnızca yöneticiye özel Test Verisi filtresinde görünür. Gerçek müşteri telefonu kullanılmaz. Bu tarihte {todaysTestReservations.length} test kaydı var.</Text>
            <View style={styles.testDataActions}>
              {[100, 500, 1000].map((count) => (
                <Pressable
                  key={count}
                  disabled={testBusy}
                  onPress={() => createTestReservations(count)}
                  style={[styles.testDataGenerateButton, testBusy && { opacity: 0.45 }]}
                >
                  <Text style={styles.testDataGenerateText}>+ {count.toLocaleString('tr-TR')}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable disabled={testBusy} style={[styles.testDataDeleteButton, testBusy && { opacity: 0.45 }]} onPress={requestTestDataDeletion}>
              <Text style={styles.testDataDeleteText}>{testBusy ? 'İşlem yapılıyor…' : 'Tüm Tarihlerdeki Test Verilerini Sil'}</Text>
            </Pressable>
            <Text style={styles.modalHelp}>Her basışta seçili güne ek test kayıtları eklenir. Test bitince üstteki temizleme butonu tüm günlerde yalnızca test kayıtlarını siler.</Text>
            <View style={styles.manageDivider} />
            <Pressable style={styles.logoutButton} onPress={logoutAdmin}><Text style={styles.logoutButtonText}>Yönetici Oturumunu Kapat</Text></Pressable>
          </View>
        )}

        {managementTab === 'history' && (
          <View>
            <View style={styles.manageHeaderRow}>
              <View style={{ flex: 1 }}><Text style={styles.sectionTitle}>Geçmiş Rezervasyon Günleri</Text><Text style={styles.modalTiny}>Yalnızca içinde rezervasyon olan, bugünden eski günler.</Text></View>
              <Pressable onPress={() => setManagementTab('settings')} style={styles.smallNeutralButton}><Text style={styles.smallNeutralText}>← Ayarlara Dön</Text></Pressable>
            </View>
            {historyError ? <Text style={styles.adminError}>{historyError}</Text> : null}
            <View style={styles.historyTools}>
              <Pressable disabled={historyBusy || !historyDates.length} style={styles.smallNeutralButton} onPress={() => setHistorySelected(historySelected.length === historyDates.length ? [] : historyDates.map((d) => d.date))}>
                <Text style={styles.smallNeutralText}>{historySelected.length === historyDates.length && historyDates.length ? 'Seçimi Kaldır' : 'Tüm Günleri Seç'}</Text>
              </Pressable>
              <Text style={styles.historyCount}>{historySelected.length} / {historyDates.length} gün seçildi</Text>
            </View>
            {historyBusy ? <Text style={styles.modalHelp}>Kayıtlar işleniyor…</Text> : historyDates.length === 0 ? (
              <Text style={styles.modalHelp}>Silinebilecek geçmiş rezervasyon bulunmuyor.</Text>
            ) : (
              <View style={styles.managementList}>
                {historyDates.slice(0, historyVisibleCount).map((day) => (
                  <Pressable key={day.date} style={styles.historyDayRow} onPress={() => toggleHistoryDate(day.date)} disabled={historyBusy}>
                    <View style={[styles.historyCheck, historySelected.includes(day.date) && styles.historyCheckActive]}><Text style={styles.historyCheckMark}>{historySelected.includes(day.date) ? '✓' : ''}</Text></View>
                    <View style={{ flex: 1 }}><Text style={styles.managementListTitle}>{prettyDate(day.date)}</Text><Text style={styles.managementListMeta}>{weekday(day.date)}</Text></View>
                    <Text style={styles.historyCount}>{day.count} rezervasyon</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {historyDates.length > historyVisibleCount && <Pressable style={styles.smallNeutralButton} onPress={() => setHistoryVisibleCount((count) => count + 60)}><Text style={styles.smallNeutralText}>Daha Fazla Gün Göster</Text></Pressable>}
            <View style={styles.modalFooter}>
              <Pressable disabled={!historySelected.length || historyBusy} style={[styles.dangerButton, (!historySelected.length || historyBusy) && { opacity: 0.4 }]} onPress={requestHistoryDeletion}>
                <Text style={styles.dangerButtonText}>Seçili {historySelected.length} Günü Sil</Text>
              </Pressable>
            </View>
            <Text style={styles.modalHelp}>Silme işlemi kalıcıdır. Masalar, alanlar, ayarlar, bugün ve ileri tarihli rezervasyonlar korunur. Seçilen günler eski arşiv yedeklerinden de temizlenir; diğer kayıtlar korunur.</Text>
          </View>
        )}
      </ModalShell>

      <ModalShell visible={showAreaModal && isAdmin} title="Yeni Alan Ekle" onClose={() => setShowAreaModal(false)} scrollable>
        <Field label="Alan adı" value={newAreaName} onChangeText={setNewAreaName} placeholder="Örn. Teras, VIP, Alt Salon" />
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: timedAreaEnabled }} onPress={() => { setTimedAreaEnabled((value) => !value); setClockAreaEnabled(false); }} style={styles.timedAreaToggle}>
          <View style={[styles.timedAreaCheck, timedAreaEnabled && styles.timedAreaCheckActive]}><Text style={styles.timedAreaCheckText}>{timedAreaEnabled ? '✓' : ''}</Text></View>
          <View style={{ flex: 1 }}><Text style={styles.timedAreaToggleTitle}>Erken Rezervasyon Alanı</Text><Text style={styles.timedAreaToggleHelp}>Rezervasyonlara geliş ve kalkış saati ekle</Text></View>
        </Pressable>
        {timedAreaEnabled && <>
          <View style={styles.twoFields}>
            <Field style={styles.halfField} label="Varsayılan Geliş Saati" value={areaStartTime} onChangeText={setAreaStartTime} placeholder="19:00" autoCapitalize="none" />
            <Field style={styles.halfField} label="Varsayılan Kalkış Saati" value={areaEndTime} onChangeText={setAreaEndTime} placeholder="20:00" autoCapitalize="none" />
          </View>
          <Text style={styles.timeInputHint}>Bu saatler rezervasyonda hazır gelir, personel değiştirebilir.</Text>
        </>}
        <View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setShowAreaModal(false)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={addArea}><Text style={styles.primaryButtonText}>Alan Ekle</Text></Pressable></View>
      </ModalShell>

      <ModalShell visible={!!renameArea && isAdmin} title="Alanı Düzenle" onClose={() => setRenameArea(null)} scrollable>
        <Field label="Alan adı" value={newAreaName} onChangeText={setNewAreaName} placeholder="Alan adı" />
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: timedAreaEnabled }} onPress={() => { setTimedAreaEnabled((value) => !value); setClockAreaEnabled(false); }} style={styles.timedAreaToggle}>
          <View style={[styles.timedAreaCheck, timedAreaEnabled && styles.timedAreaCheckActive]}><Text style={styles.timedAreaCheckText}>{timedAreaEnabled ? '✓' : ''}</Text></View>
          <View style={{ flex: 1 }}><Text style={styles.timedAreaToggleTitle}>Erken Rezervasyon Alanı</Text><Text style={styles.timedAreaToggleHelp}>Bu alana ait yeni rezervasyonların varsayılan saatleri</Text></View>
        </Pressable>
        {timedAreaEnabled && <>
          <View style={styles.twoFields}>
            <Field style={styles.halfField} label="Varsayılan Geliş Saati" value={areaStartTime} onChangeText={setAreaStartTime} placeholder="19:00" autoCapitalize="none" />
            <Field style={styles.halfField} label="Varsayılan Kalkış Saati" value={areaEndTime} onChangeText={setAreaEndTime} placeholder="20:00" autoCapitalize="none" />
          </View>
          <Text style={styles.timeInputHint}>Değişiklikler mevcut rezervasyonların saatlerini değiştirmez.</Text>
        </>}
        <View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setRenameArea(null)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={saveAreaName}><Text style={styles.primaryButtonText}>Kaydet</Text></Pressable></View>
      </ModalShell>

      <ModalShell visible={!!editTable && isAdmin} title="Masayı Düzenle" onClose={() => setEditTable(null)} width={520} scrollable>
        {editTable && <>
          <Field label="Masa adı / numarası" value={editTableName} onChangeText={setEditTableName} placeholder="Masa 1" />
          <Field label="Kapasite" value={editTableCapacity} onChangeText={setEditTableCapacity} placeholder="4" keyboardType="number-pad" />
          <Text style={styles.fieldLabel}>Kategori</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectScroller}>
            <Pressable onPress={() => setEditTableCategoryId('')} style={[styles.selectChip, !editTableCategoryId && styles.selectChipActive]}><Text style={[styles.selectChipText, !editTableCategoryId && styles.selectChipTextActive]}>Kategorisiz</Text></Pressable>
            {areaCategories(editTable.areaId).map((category) => <Pressable key={category.id} onPress={() => setEditTableCategoryId(category.id)} style={[styles.selectChip, editTableCategoryId === category.id && styles.selectChipActive]}><Text style={[styles.selectChipText, editTableCategoryId === category.id && styles.selectChipTextActive]}>{category.name}</Text></Pressable>)}
          </ScrollView>
          <View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setEditTable(null)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={saveTableEdit}><Text style={styles.primaryButtonText}>Kaydet</Text></Pressable></View>
        </>}
      </ModalShell>

      <ModalShell visible={showReservationModal} title={editingReservation ? 'Rezervasyonu Düzenle' : 'Yeni Rezervasyon'} onClose={closeReservationModal} width={620} scrollable
        footer={<View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={closeReservationModal}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={() => { Keyboard.dismiss(); saveReservation(); }}><Text style={styles.primaryButtonText}>{editingReservation ? 'Değişiklikleri Kaydet' : 'Rezervasyonu Ekle'}</Text></Pressable></View>}>

        {editingReservation || reservationPreset ? (
          <View style={styles.presetReservationBar}><Text style={styles.presetReservationText}>Masa: {data.areas.find((a) => a.id === formAreaId)?.name || 'Alan'} · {tableLabel(formTable, true)}{selectedFormTable ? ` · ${selectedFormTable.capacity || 4} kişilik` : ''}</Text></View>
        ) : (
          <>
            <Text style={styles.fieldLabel}>Alan</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectScroller}>
              {data.areas.map((area) => <Pressable key={area.id} onPress={() => {
                setFormAreaId(area.id);
                setFormTable(availableNewTables(area.id, formPeople)[0]?.number || '');
                setFormTime(area.timedArea ? (area.defaultStartTime || '19:00') : '');
                setFormEndTime(area.timedArea ? (area.defaultEndTime || '20:00') : '');
                setFormPhone(area.clockArea ? '' : '05');
              }} style={[styles.selectChip, formAreaId === area.id && styles.selectChipActive]}><Text style={[styles.selectChipText, formAreaId === area.id && styles.selectChipTextActive]}>{area.name}</Text></Pressable>)}
            </ScrollView>
            <Text style={styles.fieldLabel}>Masa</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectScroller}>
              {availableNewTables(formAreaId, formPeople).map((table) => <Pressable key={table.id} onPress={() => setFormTable(String(table.number))} style={[styles.selectChip, tableKey(formTable) === tableKey(table.number) && styles.selectChipActive]}><Text style={[styles.selectChipText, tableKey(formTable) === tableKey(table.number) && styles.selectChipTextActive]}>{tableLabel(table.number, true)} · {table.capacity || 4}K</Text></Pressable>)}
            </ScrollView>
            {!availableNewTables(formAreaId, formPeople).length && <Text style={styles.emptyTableHelp}>Bu alanda boş masa bulunmuyor.</Text>}
          </>
        )}
        <Field label="Ad Soyad" value={formName} onChangeText={setFormName} placeholder="Müşteri adı soyadı" autoCapitalize="words" />
        <View style={selectedFormArea?.clockArea ? undefined : styles.twoFields}>
          {!selectedFormArea?.clockArea && <Field
            label={selectedFormArea?.timedArea ? 'Geliş Saati' : 'Saat'}
            value={formTime}
            onChangeText={setFormTime}
            onBlur={() => {
              const parsed = parseReservationTime(formTime);
              if (parsed) setFormTime(`${pad(parsed.hour)}:${pad(parsed.minute)}`);
            }}
            placeholder=""
            keyboardType="default"
            autoCapitalize="none"
            style={styles.halfField}
          />}
          <Field
            label="Kişi Sayısı"
            value={formPeople}
            onChangeText={(value) => {
              const next = value.replace(/\D/g, '');
              setFormPeople(next);
              if (!editingReservation && !reservationPreset) {
                const choices = availableNewTables(formAreaId, next);
                if (!choices.some((t) => tableKey(t.number) === tableKey(formTable))) setFormTable(choices[0]?.number || '');
              }
            }}
            placeholder=""
            keyboardType="number-pad"
            autoCapitalize="none"
            style={selectedFormArea?.clockArea ? undefined : styles.halfField}
          />
        </View>
        {(selectedFormArea?.timedArea || selectedFormArea?.clockArea) && <Field
          label="Kalkış Saati"
          value={formEndTime}
          onChangeText={setFormEndTime}
          onBlur={() => {
            const parsed = parseReservationTime(formEndTime);
            if (parsed) setFormEndTime(`${pad(parsed.hour)}:${pad(parsed.minute)}`);
          }}
          placeholder="20:00"
          autoCapitalize="none"
          keyboardType="default"
        />}
        <Text style={styles.timeInputHint}>{selectedFormArea?.clockArea ? 'Kalkış saatini 20:00 şeklinde gir. Süre dolduğunda Gecikti olarak işaretlenir.' : `Saat için 19:30, 19.30, 19-30 veya 1930 yazabilirsin.${selectedFormArea?.timedArea ? ' Erken rezervasyonda kalkış saati de kaydedilir.' : ''}`}</Text>
        {!selectedFormArea?.clockArea && <Field label="Telefon" value={formPhone} onChangeText={setFormPhone} placeholder="05xx xxx xx xx" keyboardType="phone-pad" autoCapitalize="none" />}
      </ModalShell>

      <ModalShell visible={!!noteTable} title="Masa Notu" onClose={() => { setNoteTable(null); setNoteReservationId(null); }} width={490} scrollable
        footer={<View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => { setNoteTable(null); setNoteReservationId(null); }}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.cancelButton} onPress={clearTableNote}><Text style={styles.cancelText}>Temizle</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={saveTableNote}><Text style={styles.primaryButtonText}>Notu Kaydet</Text></Pressable></View>}>
        <Text style={styles.modalHelp}>{noteTable ? tableLabel(noteTable.number, true) : ''} için yalnızca {prettyDate(selectedDate)} tarihine ait not. Rezervasyon silinirse bağlı not da silinir.</Text>
        <TextInput style={styles.noteInput} multiline maxLength={200} placeholder="Örn: Çocuk sandalyesi gerekli" placeholderTextColor="#98A2B3" value={noteDraft} onChangeText={setNoteDraft} />
      </ModalShell>

      <ModalShell visible={!!menuReservation || !!arrivalReservation} title={arrivalReservation ? 'Alınan Masa' : 'Rezervasyon'} onClose={() => { setMenuReservation(null); setArrivalReservation(null); setSeatedTableInput(''); }} width={470} scrollable>
        {arrivalReservation && <View>
          <View style={styles.menuReservationInfo}>
            <Text style={styles.menuReservationName}>{arrivalReservation.fullName}</Text>
            <Text style={styles.menuReservationMeta}>{arrivalReservation.people} kişi · {arrivalReservation.time} · Rezervasyon: {tableLabel(arrivalReservation.tableNumber, true)}</Text>
          </View>
          <Text style={styles.arrivalHelp}>Misafiri hangi masaya aldınız? Alınan masa numarası rezervasyon listesindeki “Geldi” bilgisinin yanında görünecek.</Text>
          <View style={styles.fieldWrap}>
            <Text style={styles.fieldLabel}>Alınan masa</Text>
            <TextInput
              value={seatedTableInput}
              onChangeText={setSeatedTableInput}
              maxLength={40}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="Örn: 21"
              placeholderTextColor="#98A2B3"
              style={styles.field}
              returnKeyType="done"
              onSubmitEditing={confirmArrival}
            />
          </View>
          <View style={styles.modalFooter}>
            <Pressable style={styles.cancelButton} onPress={() => { setArrivalReservation(null); setSeatedTableInput(''); }}><Text style={styles.cancelText}>Vazgeç</Text></Pressable>
            <Pressable style={styles.primaryButtonLarge} onPress={confirmArrival}><Text style={styles.primaryButtonText}>Tamam</Text></Pressable>
          </View>
        </View>}
        {menuReservation && <View>
          <View style={styles.menuReservationInfo}><Text style={styles.menuReservationName}>{menuReservation.fullName}</Text><Text style={styles.menuReservationMeta}>{tableLabel(menuReservation.tableNumber, true)} · {menuReservation.people} kişi · {clockAreaIds.has(menuReservation.areaId) ? `Kalkış ${menuReservation.endTime || menuReservation.time}` : menuReservation.time}</Text></View>
          {Object.entries(STATUS).map(([key, status]) => <React.Fragment key={key}>
            <Pressable onPress={() => { updateReservation(menuReservation.id, { status: key, seatedTable: '', guestArrived: false, autoCancelled: false }); if (key === 'cancelled') cancelClockAlert(menuReservation.id); setMenuReservation(null); }} style={styles.statusOption}>
              <View style={[styles.statusDot, { backgroundColor: status.color }]} /><Text style={styles.statusOptionText}>{status.label}</Text>{menuReservation.status === key && !menuReservation.seatedTable && <Text style={styles.selectedCheck}>✓</Text>}
            </Pressable>
            {key === 'arrived' && <Pressable style={styles.statusOption} onPress={() => beginArrival(menuReservation)}><View style={[styles.statusDot, { backgroundColor: COLORS.blue }]} /><Text style={styles.statusOptionText}>Misafiri Geldi</Text><Text style={styles.menuActionSub}>Masa numarası gir</Text>{menuReservation.status === 'arrived' && !!menuReservation.seatedTable && <Text style={styles.selectedCheck}>✓</Text>}</Pressable>}
          </React.Fragment>)}
          <Pressable style={styles.menuActionButton} onPress={() => openTableNote(getTable(menuReservation.areaId, menuReservation.tableNumber), menuReservation)}><Text style={styles.menuActionIcon}>▤</Text><View style={styles.menuActionContent}><Text style={styles.menuActionTitle}>Masa Notu</Text><Text style={styles.menuActionSub}>Bu güne ve rezervasyona ait not ekle veya düzenle</Text></View></Pressable>
          <View style={styles.menuDivider} />
          <Pressable style={styles.menuActionButton} onPress={() => openEditReservation(menuReservation)}><Text style={styles.menuActionIcon}>✎</Text><View style={styles.menuActionContent}><Text style={styles.menuActionTitle}>Düzenle</Text><Text style={styles.menuActionSub}>Yalnızca ad, saat, kişi sayısı ve telefonu değiştir</Text></View></Pressable>
          <Pressable style={styles.menuActionButton} onPress={() => openMoveReservation(menuReservation)}><Text style={styles.menuActionIcon}>⇄</Text><View style={styles.menuActionContent}><Text style={styles.menuActionTitle}>Başka Masaya Taşı</Text><Text style={styles.menuActionSub}>Alan ve yeni boş masayı seç</Text></View></Pressable>
          <Pressable style={[styles.menuActionButton, styles.menuDangerButton]} onPress={() => requestDeleteReservation(menuReservation)}><Text style={[styles.menuActionIcon, styles.menuDangerText]}>×</Text><View style={styles.menuActionContent}><Text style={[styles.menuActionTitle, styles.menuDangerText]}>Rezervasyonu Sil</Text><Text style={styles.menuActionSub}>Kişiyi masadan kaldır ve masayı boşalt</Text></View></Pressable>
        </View>}
      </ModalShell>

      <ModalShell visible={!!moveReservation} title="Rezervasyonu Başka Masaya Taşı" onClose={() => setMoveReservation(null)} width={620} scrollable>
        {moveReservation && <View>
          <View style={styles.moveCurrentBox}><Text style={styles.moveCurrentName}>{moveReservation.fullName}</Text><Text style={styles.moveCurrentMeta}>Şu an: {data.areas.find((a) => a.id === moveReservation.areaId)?.name || 'Alan'} · {tableLabel(moveReservation.tableNumber, true)} · {moveReservation.time}</Text></View>
          <Text style={styles.fieldLabel}>Yeni alan</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectScroller}>{data.areas.map((area) => <Pressable key={area.id} onPress={() => { setMoveAreaId(area.id); setMoveTableNumber(''); }} style={[styles.selectChip, moveAreaId === area.id && styles.selectChipActive]}><Text style={[styles.selectChipText, moveAreaId === area.id && styles.selectChipTextActive]}>{area.name}</Text></Pressable>)}</ScrollView>
          <Text style={styles.fieldLabel}>Boş masa</Text>
          <View style={styles.moveTableGrid}>{availableMoveTables(moveAreaId, moveReservation).map((table) => <Pressable key={table.id} onPress={() => setMoveTableNumber(String(table.number))} style={[styles.moveTableChip, tableKey(moveTableNumber) === tableKey(table.number) && styles.moveTableChipActive]}><Text style={[styles.moveTableChipText, tableKey(moveTableNumber) === tableKey(table.number) && styles.moveTableChipTextActive]}>{tableLabel(table.number, true)} · {table.capacity || 4}K</Text></Pressable>)}</View>
          {!availableMoveTables(moveAreaId, moveReservation).length && <View style={styles.noTablesBox}><Text style={styles.noTablesText}>Bu alanda taşınabilecek boş masa yok.</Text></View>}
          <View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setMoveReservation(null)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable style={styles.primaryButtonLarge} onPress={confirmMoveReservation}><Text style={styles.primaryButtonText}>Masaya Taşı</Text></Pressable></View>
        </View>}
      </ModalShell>

      <ModalShell visible={!!pendingDelete} title={pendingDelete?.title || 'Silme Onayı'} onClose={() => setPendingDelete(null)} width={460} scrollable>
        {pendingDelete && <View><Text style={styles.deleteConfirmText}>{pendingDelete.message}</Text><View style={styles.deleteConfirmWarning}><Text style={styles.deleteConfirmWarningText}>Bu işlem geri alınamaz.</Text></View><View style={styles.modalFooter}><Pressable style={styles.cancelButton} onPress={() => setPendingDelete(null)}><Text style={styles.cancelText}>Vazgeç</Text></Pressable><Pressable disabled={(historyBusy && pendingDelete?.type === 'history') || (testBusy && pendingDelete?.type === 'testData')} style={[styles.dangerButton, ((historyBusy && pendingDelete?.type === 'history') || (testBusy && pendingDelete?.type === 'testData')) && { opacity: 0.5 }]} onPress={confirmDelete}><Text style={styles.dangerButtonText}>{(historyBusy && pendingDelete?.type === 'history') || (testBusy && pendingDelete?.type === 'testData') ? 'Siliniyor…' : 'Sil'}</Text></Pressable></View></View>}
      </ModalShell>
    </SafeAreaView>
  );
}
function createStyles() { return StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg, gap: 16 },
  loadingText: { fontSize: 16, color: COLORS.muted },
  topNotice: {
    position: 'absolute',
    zIndex: 50,
    top: 12,
    alignSelf: 'center',
    left: 20,
    right: 20,
    maxWidth: 520,
    minHeight: 66,
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 11,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  noticeDot: { width: 11, height: 11, borderRadius: 6, marginRight: 11 },
  noticeContent: { flex: 1 },
  noticeTitle: { fontSize: 13, fontWeight: '900' },
  noticeText: { color: '#344054', fontSize: 12, marginTop: 2, fontWeight: '600' },
  noticeClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  noticeCloseText: { color: '#667085', fontSize: 24, marginTop: -2 },
  header: {
    minHeight: 86,
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  headerCompact: { flexWrap: 'wrap', alignContent: 'center', rowGap: 8 },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 190, flexShrink: 1 },
  brandLogo: { width: 46, height: 46, borderRadius: 13 },
  brandName: { fontSize: 18, fontWeight: '800', color: COLORS.text, letterSpacing: -0.5 },
  brandSub: { fontSize: 12, color: COLORS.muted, marginTop: 2 },
  datePickerWrap: { flexDirection: 'row', borderWidth: 1, borderColor: COLORS.line, borderRadius: 14, backgroundColor: '#FCFCFD', height: 50, alignItems: 'center', flexShrink: 0 },
  datePickerWrapCompact: { marginLeft: 'auto' },
  dateArrow: { width: 38, height: '100%', alignItems: 'center', justifyContent: 'center' },
  dateArrowText: { fontSize: 28, color: COLORS.text, marginTop: -2 },
  dateCenter: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8 },
  calendarGlyph: { fontSize: 20, color: COLORS.blue },
  dateText: { color: COLORS.text, fontSize: 14, fontWeight: '800' },
  weekdayText: { color: COLORS.muted, fontSize: 11, marginTop: 1, textTransform: 'capitalize' },
  headerActions: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, minWidth: 0 },
  headerActionsCompact: { flexBasis: '100%', width: '100%', justifyContent: 'stretch' },
  searchWrap: { height: 44, minWidth: 150, maxWidth: 390, flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: COLORS.line, borderRadius: 13, paddingHorizontal: 11 },
  searchGlyph: { fontSize: 24, color: '#667085', marginRight: 7, marginTop: -3 },
  searchInput: { flex: 1, color: COLORS.text, fontSize: 14, paddingVertical: 0 },
  searchClearButton: { width: 27, height: 27, borderRadius: 8, backgroundColor: '#E9EFF7', alignItems: 'center', justifyContent: 'center', marginLeft: 5 },
  searchClearText: { fontSize: 20, color: '#667085', fontWeight: '700', marginTop: -2 },
  secondaryButton: { height: 44, paddingHorizontal: 12, borderRadius: 13, borderWidth: 1, borderColor: COLORS.blueBorder, backgroundColor: COLORS.blueSoft, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontWeight: '800', color: COLORS.blue, fontSize: 13 },
  primaryButton: { height: 44, paddingHorizontal: 13, borderRadius: 13, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  clockAlertBanner: { marginHorizontal: 12, marginBottom: 5, paddingVertical: 2, paddingLeft: 10, paddingRight: 3, minHeight: 33, backgroundColor: '#FFF1F1', borderWidth: 1, borderColor: '#FCA5A5', borderRadius: 8, flexDirection: 'row', alignItems: 'center' },
  clockAlertBannerBody: { flex: 1, minWidth: 0, justifyContent: 'center', paddingVertical: 4 },
  clockAlertBannerText: { color: '#B42318', fontWeight: '800', fontSize: 11 },
  clockAlertClose: { width: 30, height: 28, alignItems: 'center', justifyContent: 'center', marginLeft: 5 },
  clockAlertCloseText: { color: '#B42318', fontSize: 20, fontWeight: '700', lineHeight: 25 },
  clockOverdueRow: { backgroundColor: '#FEE2E2', borderColor: '#F87171', borderWidth: 1.4 },
  arrivedSoftRow: { backgroundColor: 'rgba(37,99,235,0.095)', borderColor: 'rgba(37,99,235,0.25)', borderWidth: 1 },
  clockOverdueBadge: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6, backgroundColor: '#DC2626', alignItems: 'center', justifyContent: 'center' },
  clockOverdueBadgeText: { color: '#FFFFFF', fontWeight: '900', fontSize: 10 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingVertical: 6 },
  chipsRow: { alignItems: 'center', gap: 9, paddingRight: 8 },
  capacityToolbar: { flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 8 },
  capacityCycleButton: { height: 38, minWidth: 90, borderRadius: 10, backgroundColor: '#F0F5FF', borderColor: '#BDD0FF', borderWidth: 1, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  capacityCycleButtonActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  capacityCycleText: { fontSize: 11, fontWeight: '800', color: COLORS.blue },
  capacityCycleTextActive: { color: '#FFFFFF' },
  capacityClearButton: { width: 29, height: 29, borderWidth: 1, borderColor: '#FDA29B', borderRadius: 7, backgroundColor: '#FFF1F1', alignItems: 'center', justifyContent: 'center' },
  capacityClearText: { color: '#E5484D', fontSize: 19, fontWeight: '900', marginTop: -2 },
  chip: { height: 40, borderRadius: 11, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.line },
  chipActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  chipText: { color: '#475467', fontWeight: '700', fontSize: 13 },
  chipTextActive: { color: '#FFFFFF' },
  countBadge: { minWidth: 24, height: 23, borderRadius: 12, backgroundColor: '#F2F4F7', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  countBadgeActive: { backgroundColor: 'rgba(255,255,255,0.2)' },
  countText: { color: '#667085', fontSize: 11, fontWeight: '800' },
  countTextActive: { color: '#FFFFFF' },
  upcomingWindowButton: { height: 40, borderRadius: 11, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: COLORS.blueBorder },
  upcomingWindowButtonText: { color: COLORS.blue, fontWeight: '900', fontSize: 12 },
  addAreaButton: { marginLeft: 'auto', height: 40, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13 },
  addAreaButtonText: { color: COLORS.text, fontWeight: '800', fontSize: 12 },
  areaScroller: { flex: 1, minHeight: 0 },
  areaContent: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  areaCard: { minWidth: 0, backgroundColor: COLORS.card, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, overflow: 'hidden' },
  areaHeader: { minHeight: 82, borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 8, justifyContent: 'space-between' },
  areaTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  areaTitle: { color: COLORS.text, fontSize: 21, fontWeight: '900', letterSpacing: -0.4 },
  renameButton: { width: 28, height: 28, borderRadius: 8, backgroundColor: '#F2F4F7', alignItems: 'center', justifyContent: 'center' },
  renameText: { color: '#475467', fontSize: 14, fontWeight: '800' },
  deleteAreaButton: { height: 28, borderRadius: 8, backgroundColor: COLORS.redSoft, borderWidth: 1, borderColor: '#FECDCA', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 },
  deleteAreaText: { color: '#B42318', fontSize: 11, fontWeight: '900' },
  areaMeta: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  legendWrap: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingLeft: 9 },
  legendText: { width: 56, color: '#98A2B3', fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  legendTextWide: { flex: 1.3, color: '#98A2B3', fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  legendTextPhone: { flex: 1, color: '#98A2B3', fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  rowsWrap: { padding: 10, gap: 8, paddingBottom: 22 },
  row: { minHeight: 78, borderRadius: 14, backgroundColor: '#FBFCFE', borderWidth: 1, borderColor: '#EAECF0', flexDirection: 'row', alignItems: 'center', overflow: 'hidden', paddingRight: 10 },
  rowImportant: { backgroundColor: COLORS.starSoft, borderColor: '#FDE68A' },
  emptyTableRow: { backgroundColor: '#FAFBFC', borderStyle: 'solid', borderColor: '#D0D5DD' },
  statusBar: { width: 5, alignSelf: 'stretch', marginRight: 10 },
  tableCell: { width: 66 },
  tableNumber: { fontSize: 19, fontWeight: '900', color: COLORS.text },
  timeText: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
  emptyTableTime: { color: '#98A2B3', fontSize: 11, marginTop: 2, fontWeight: '700' },
  nameCell: { flex: 1.3, paddingRight: 8 },
  nameText: { color: COLORS.text, fontSize: 14, fontWeight: '800', marginBottom: 5 },
  emptyTableTitle: { color: '#667085', fontSize: 14, fontWeight: '800' },
  emptyTableHint: { color: '#98A2B3', fontSize: 10, marginTop: 4 },
  badgesRow: { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  statusBadge: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 8, height: 23, alignItems: 'center', justifyContent: 'center' },
  statusText: { fontSize: 10, fontWeight: '800' },
  delayBadge: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 7, height: 23, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  delayBadgeText: { fontSize: 9, fontWeight: '900' },
  peopleCell: { width: 66 },
  peopleText: { color: '#475467', fontSize: 12, fontWeight: '700' },
  phoneCell: { flex: 1, paddingRight: 5 },
  phoneText: { color: '#475467', fontSize: 12, fontWeight: '600' },
  emptyDash: { color: '#B7BEC8', fontSize: 14, fontWeight: '700' },
  rowActions: { width: 82, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  starButton: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: COLORS.line },
  starButtonActive: { backgroundColor: '#FEF3C7', borderColor: '#FCD34D' },
  starText: { fontSize: 22, color: '#98A2B3', marginTop: -2 },
  starTextActive: { color: COLORS.star },
  moreButton: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: COLORS.line },
  moreText: { color: '#475467', fontSize: 16, fontWeight: '900', marginTop: -7 },
  emptyAddButton: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blueSoft, borderWidth: 1, borderColor: COLORS.blueBorder },
  emptyAddText: { color: COLORS.blue, fontSize: 20, fontWeight: '900', marginTop: -1 },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  emptyIcon: { fontSize: 38, color: '#D0D5DD' },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: COLORS.text, marginTop: 8 },
  emptyText: { fontSize: 12, color: COLORS.muted, marginTop: 4 },
  testDataActions: { flexDirection: 'row', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  testDataGenerateButton: { minWidth: 112, height: 46, paddingHorizontal: 20, borderWidth: 1, borderColor: COLORS.blueBorder, borderRadius: 12, backgroundColor: COLORS.blueSoft, justifyContent: 'center', alignItems: 'center' },
  testDataGenerateText: { fontSize: 14, fontWeight: '800', color: COLORS.blue },
  testDataDeleteButton: { height: 46, borderRadius: 12, borderWidth: 1, borderColor: '#FECDD3', backgroundColor: '#FFF1F2', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  testDataDeleteText: { color: '#BE123C', fontSize: 13, fontWeight: '800' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(16,24,40,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: COLORS.card, borderRadius: 20, padding: 20, maxHeight: '92%', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 12 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  modalTitle: { fontSize: 20, fontWeight: '900', color: COLORS.text },
  iconButton: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#F2F4F7', alignItems: 'center', justifyContent: 'center' },
  iconButtonText: { fontSize: 24, color: '#475467', marginTop: -2 },
  fieldWrap: { marginBottom: 14 },
  fieldLabel: { color: '#344054', fontSize: 12, fontWeight: '800', marginBottom: 7 },
  field: { height: 48, borderWidth: 1, borderColor: '#D0D5DD', borderRadius: 12, paddingHorizontal: 13, color: COLORS.text, backgroundColor: '#FFFFFF', fontSize: 14 },
  modalFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 10 },
  cancelButton: { height: 46, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: '#344054', fontWeight: '800', fontSize: 13 },
  primaryButtonLarge: { height: 46, paddingHorizontal: 20, borderRadius: 12, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' },
  fullPrimaryButton: { height: 46, borderRadius: 12, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  modalHelp: { color: COLORS.muted, fontSize: 12, lineHeight: 18, marginBottom: 16 },
  selectScroller: { marginBottom: 16, flexGrow: 0 },
  selectChip: { height: 40, paddingHorizontal: 15, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  selectChipActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  selectChipText: { color: '#475467', fontSize: 13, fontWeight: '800' },
  selectChipTextActive: { color: '#FFFFFF' },
  twoFields: { flexDirection: 'row', gap: 12 },
  halfField: { flex: 1 },
  timeInputHint: { color: '#667085', fontSize: 10, marginTop: -7, marginBottom: 12 },
  rangePreview: { backgroundColor: COLORS.blueSoft, borderRadius: 12, padding: 12, marginBottom: 4 },
  rangePreviewText: { color: COLORS.blue, fontWeight: '800', fontSize: 12 },
  modalTiny: { color: COLORS.muted, fontSize: 11, marginTop: -4 },
  menuReservationInfo: { borderRadius: 12, backgroundColor: '#F8FAFC', padding: 13, marginBottom: 8 },
  menuReservationName: { fontSize: 15, fontWeight: '900', color: COLORS.text },
  menuReservationMeta: { color: COLORS.muted, fontSize: 11, marginTop: 4 },
  statusOption: { height: 50, borderBottomWidth: 1, borderBottomColor: '#F2F4F7', flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 11 },
  statusOptionText: { flex: 1, color: COLORS.text, fontSize: 14, fontWeight: '700' },
  selectedCheck: { color: COLORS.blue, fontSize: 18, fontWeight: '900' },
  menuDivider: { height: 1, backgroundColor: COLORS.line, marginVertical: 9 },
  menuActionButton: { minHeight: 58, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, marginTop: 8 },
  menuActionIcon: { width: 34, color: COLORS.blue, fontSize: 24, fontWeight: '900' },
  menuActionContent: { flex: 1 },
  menuActionTitle: { color: COLORS.text, fontSize: 13, fontWeight: '900' },
  menuActionSub: { color: COLORS.muted, fontSize: 10, marginTop: 2 },
  menuDangerButton: { borderColor: '#FECDCA', backgroundColor: COLORS.redSoft },
  menuDangerText: { color: '#B42318' },
  tableModalScroll: { maxHeight: 560 },
  sectionTitle: { color: COLORS.text, fontSize: 14, fontWeight: '900', marginBottom: 10, marginTop: 2 },
  manageDivider: { height: 1, backgroundColor: COLORS.line, marginVertical: 20 },
  manageHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  deleteAllTablesButton: { height: 36, paddingHorizontal: 13, borderRadius: 10, borderWidth: 1, borderColor: '#FDA29B', backgroundColor: '#FFF5F5', alignItems: 'center', justifyContent: 'center' },
  deleteAllTablesText: { color: '#D92D20', fontSize: 11, fontWeight: '900' },
  tableChipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 6 },
  tableManageChip: { height: 42, minWidth: 118, paddingLeft: 11, paddingRight: 5, borderRadius: 10, borderWidth: 1, borderColor: '#FECDCA', backgroundColor: COLORS.redSoft, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tableManageText: { color: '#344054', fontSize: 11, fontWeight: '800' },
  tableDeleteButton: { height: 30, paddingHorizontal: 9, borderRadius: 8, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#FDA29B', alignItems: 'center', justifyContent: 'center' },
  tableDeleteText: { color: '#D92D20', fontSize: 11, fontWeight: '900' },
  noTablesBox: { borderRadius: 12, backgroundColor: '#F8FAFC', padding: 18, alignItems: 'center' },
  noTablesText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  singleTableCreateRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  singleTableField: { flex: 1 },
  singleTableAddButton: { height: 48, paddingHorizontal: 18, marginBottom: 14, borderRadius: 12, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' },
  draggingRowWrap: { zIndex: 60, elevation: 14 },
  draggingRow: { shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 12, shadowOffset: { width: 0, height: 7 }, borderColor: COLORS.blueStrongBorder, backgroundColor: '#FFFFFF' },
  quickTimeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  quickTimeChip: { height: 38, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  quickTimeChipActive: { backgroundColor: COLORS.blueSoft, borderColor: COLORS.blueStrongBorder },
  quickTimeChipText: { color: '#475467', fontSize: 12, fontWeight: '800' },
  quickTimeChipTextActive: { color: COLORS.blue },
  moveCurrentBox: { backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, padding: 13, marginBottom: 16 },
  moveCurrentName: { color: COLORS.text, fontSize: 15, fontWeight: '900' },
  moveCurrentMeta: { color: COLORS.muted, fontSize: 11, marginTop: 4 },
  moveTableList: { maxHeight: 240, marginBottom: 10 },
  moveTableGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 4 },
  moveTableChip: { height: 42, minWidth: 88, paddingHorizontal: 13, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  moveTableChipActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  moveTableChipText: { color: '#475467', fontSize: 12, fontWeight: '800' },
  moveTableChipTextActive: { color: '#FFFFFF' },

  presetReservationBar: { backgroundColor: COLORS.blueSoft, borderWidth: 1, borderColor: COLORS.blueBorder, borderRadius: 12, paddingHorizontal: 14, height: 42, justifyContent: 'center', marginBottom: 14 },
  presetReservationText: { color: COLORS.blue, fontSize: 13, fontWeight: '900' },
  deleteConfirmText: { color: COLORS.text, fontSize: 14, lineHeight: 21 },
  deleteConfirmWarning: { marginTop: 14, backgroundColor: COLORS.redSoft, borderRadius: 10, borderWidth: 1, borderColor: '#FECDCA', padding: 11 },
  deleteConfirmWarningText: { color: '#B42318', fontSize: 12, fontWeight: '800' },
  dangerButton: { height: 46, paddingHorizontal: 20, borderRadius: 12, backgroundColor: COLORS.red, alignItems: 'center', justifyContent: 'center' },
  dangerButtonText: { color: '#FFFFFF', fontWeight: '900', fontSize: 13 },

  modalBodyScroll: { flexShrink: 1, minHeight: 0, flexGrow: 0 },
  modalScrollContent: { paddingBottom: 20, flexGrow: 0 },
  adminLoginButton: { height: 42, paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: '#D0D5DD', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  adminLoginButtonText: { color: '#475467', fontSize: 12, fontWeight: '800' },
  adminError: { color: '#D92D20', fontSize: 12, fontWeight: '700', marginTop: -4, marginBottom: 8 },

  areaHeaderCompact: { minHeight: 64, borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingHorizontal: 10, paddingTop: 7, paddingBottom: 5, justifyContent: 'space-between' },
  legendWrapCompact: { flexDirection: 'row', alignItems: 'center', paddingLeft: 7, marginTop: 3 },
  legendMasa: { width: 46, color: '#98A2B3', fontSize: 8.5, fontWeight: '800', textTransform: 'uppercase' },
  legendName: { flex: 1.2, color: '#98A2B3', fontSize: 8.5, fontWeight: '800', textTransform: 'uppercase' },
  legendTime: { width: 48, paddingLeft: 4, color: '#98A2B3', fontSize: 8.5, fontWeight: '800', textTransform: 'uppercase' },
  legendPeople: { width: 48, paddingLeft: 4, color: '#98A2B3', fontSize: 8.5, fontWeight: '800', textTransform: 'uppercase' },
  legendPhone: { flex: 1, color: '#98A2B3', fontSize: 8.5, fontWeight: '800', textTransform: 'uppercase' },
  legendStatus: { width: 62, color: '#98A2B3', fontSize: 8.5, fontWeight: '800', textTransform: 'uppercase' },
  legendActions: { width: 70 },
  compactRowsWrap: { paddingHorizontal: 7, paddingTop: 5, paddingBottom: 12 },
  historyTools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginVertical: 12 },
  historyDayRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  historyCheck: { width: 25, height: 25, borderWidth: 1.5, borderRadius: 7, borderColor: '#98A2B3', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  historyCheckActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  historyCheckMark: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  historyCount: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  categoryGroup: { marginBottom: 2 },
  categoryDivider: { height: 28, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 5, marginVertical: 3 },
  categoryLine: { flex: 1, height: 2, backgroundColor: COLORS.blue, opacity: 0.9, borderRadius: 3, shadowColor: COLORS.blue, shadowOpacity: 0.65, shadowRadius: 5, elevation: 2 },
  categoryDividerText: { color: COLORS.blue, fontSize: 11, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5, textShadowColor: 'rgba(37,99,235,0.35)', textShadowRadius: 6 },

  compactTableCell: { width: 46, paddingRight: 3 },
  compactTableNumber: { color: COLORS.text, fontSize: 14, fontWeight: '900' },
  emptyTableNumber: { color: '#A8B0BD', fontSize: 14, fontWeight: '800' },
  compactNameCell: { flex: 1.2, paddingRight: 3 },
  compactNameText: { color: COLORS.text, fontSize: 11.5, fontWeight: '800' },
  emptyTableTitleMuted: { color: '#A8B0BD', fontSize: 11, fontWeight: '700' },
  compactTimeCell: { width: 48, paddingRight: 3 },
  shiftedTimeCell: { paddingLeft: 4, paddingRight: 0 },
  compactTimeText: { color: '#475467', fontSize: 10.5, fontWeight: '800' },
  compactEndTimeText: { color: COLORS.blue, fontSize: 8.5, fontWeight: '800', marginTop: 1 },
  compactPeopleCell: { width: 48, paddingRight: 0 },
  shiftedPeopleCell: { paddingLeft: 4 },
  compactPeopleText: { color: '#475467', fontSize: 10, fontWeight: '700' },
  emptyCapacityText: { color: '#A8B0BD', fontSize: 8.5, fontWeight: '700' },
  compactPhoneCell: { flex: 1, paddingRight: 4 },
  compactPhoneText: { color: '#475467', fontSize: 9.5, fontWeight: '600' },
  compactStatusCell: { width: 62, alignItems: 'flex-start', justifyContent: 'center' },
  compactStatusWithSeatedTable: { width: 83 },
  arrivalTagsInline: { flexDirection: 'row', alignItems: 'center', gap: 4, width: '100%' },
  arrivalTag: { height: 19, borderRadius: 6, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blueSoft },
  arrivalTableTag: { flexShrink: 1 },
  arrivalTagText: { color: COLORS.blue, fontSize: 8.5, fontWeight: '900', textShadowColor: 'rgba(37,99,235,0.34)', textShadowRadius: 5, textShadowOffset: { width: 0, height: 0 } },
  arrivalHelp: { color: COLORS.muted, fontSize: 12, lineHeight: 19, marginVertical: 12 },
  compactActions: { width: 75, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 7 },
  editRowButton: { height: 27, paddingHorizontal: 7, borderRadius: 7, borderWidth: 1, borderColor: COLORS.blueBorder, backgroundColor: COLORS.blueSoft, alignItems: 'center', justifyContent: 'center' },
  editRowButtonText: { color: COLORS.blue, fontSize: 8.5, fontWeight: '900' },
  starButtonCompact: { width: 27, height: 27, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: COLORS.line },
  starTextCompact: { fontSize: 16, color: '#98A2B3', marginTop: -1 },
  moreButtonCompact: { width: 27, height: 27, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: COLORS.line },
  moreTextCompact: { color: '#98A2B3', fontSize: 20, lineHeight: 23, fontWeight: '700', includeFontPadding: false, textAlign: 'center', textAlignVertical: 'center', transform: [{ translateY: -1 }] },
  emptyAddButtonCompact: { width: 29, height: 29, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blueSoft, borderWidth: 1, borderColor: COLORS.blueBorder },
  plusHorizontal: { position: 'absolute', width: 13, height: 2, borderRadius: 1, backgroundColor: COLORS.blue },
  plusVertical: { position: 'absolute', width: 2, height: 13, borderRadius: 1, backgroundColor: COLORS.blue },
  emptyAddTextCompact: { color: COLORS.blue, fontSize: 16, fontWeight: '900', includeFontPadding: false, textAlignVertical: 'center', textAlign: 'center' },
  emptyDashCompact: { color: '#C0C6D0', fontSize: 11, fontWeight: '700' },

  quickAreaCard: { paddingHorizontal: 9, paddingVertical: 9 },
  quickSplitRow: { flex: 1, flexDirection: 'row', minHeight: 0 },
  quickHalfPanel: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: '#E5EBF6', borderRadius: 12, paddingHorizontal: 7, paddingVertical: 8, backgroundColor: '#FFFFFF' },
  quickPanelHeader: { height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5 },
  quickPanelTitle: { color: COLORS.text, fontSize: 14, fontWeight: '900' },
  quickPanelCount: { color: COLORS.blue, fontSize: 10, fontWeight: '900', backgroundColor: COLORS.blueSoft, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 10 },
  quickPanelCaption: { fontSize: 9, color: COLORS.muted, paddingBottom: 7 },
  quickPanelList: { flex: 1, minHeight: 0 },
  quickPanelListContent: { paddingBottom: 6, gap: 4, flexGrow: 1 },
  quickPanelEmpty: { paddingTop: 20, paddingHorizontal: 3, textAlign: 'center', fontSize: 10, color: '#98A2B3' },
  quickListRow: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F9FAFC', borderRadius: 8, paddingHorizontal: 5, paddingVertical: 5, borderWidth: 1, borderColor: '#E5E7EB' },
  quickLateRow: { backgroundColor: '#FEE2E2', borderColor: '#F87171', borderWidth: 1.4 },
  quickLateText: { color: '#C62828', fontWeight: '800' },
  quickRowTextWrap: { flex: 1, minWidth: 0 },
  quickRowName: { color: COLORS.text, fontWeight: '800', fontSize: 11 },
  quickRowMeta: { color: COLORS.muted, marginTop: 2, fontSize: 9, fontWeight: '600' },
  quickDoneButton: { minWidth: 45, height: 29, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blueSoft, borderWidth: 1, borderColor: COLORS.blueBorder, paddingHorizontal: 5 },
  quickTakenButton: { minWidth: 52 },
  quickDoneText: { color: COLORS.blue, fontSize: 9.5, fontWeight: '900' },
  quickAddRow: { height: 42, backgroundColor: COLORS.blueSoft, borderRadius: 9, borderWidth: 1, borderColor: COLORS.blueBorder, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  quickAddIcon: { height: 23, width: 23, borderRadius: 6, backgroundColor: '#DCEBFF', alignItems: 'center', justifyContent: 'center' },
  managementTabs: { flexDirection: 'row', gap: 7, padding: 4, borderRadius: 12, backgroundColor: '#F2F4F7', marginBottom: 18 },
  managementTab: { flex: 1, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  managementTabActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 5, elevation: 2 },
  managementTabText: { color: '#667085', fontSize: 11, fontWeight: '800' },
  managementTabTextActive: { color: COLORS.blue },
  primaryButtonSmall: { height: 38, paddingHorizontal: 13, borderRadius: 10, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' },
  managementList: { gap: 8, marginTop: 8 },
  managementListRow: { minHeight: 52, borderRadius: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FAFBFC', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, gap: 8 },
  managementListTitle: { flex: 1, color: COLORS.text, fontSize: 12, fontWeight: '900' },
  managementListMeta: { color: COLORS.muted, fontSize: 10, fontWeight: '700' },
  timedAreaMeta: { color: COLORS.blue, fontSize: 10, fontWeight: '700', marginTop: 3 },
  timedAreaToggle: { minHeight: 62, borderRadius: 11, borderWidth: 1, borderColor: COLORS.blueBorder, backgroundColor: COLORS.blueSoft, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 14 },
  timedAreaCheck: { width: 23, height: 23, borderRadius: 7, borderWidth: 1.5, borderColor: COLORS.blueBorder, backgroundColor: '#FFFFFF', justifyContent: 'center', alignItems: 'center' },
  timedAreaCheckActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  timedAreaCheckText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900', includeFontPadding: false },
  timedAreaToggleTitle: { color: COLORS.text, fontSize: 12, fontWeight: '800' },
  timedAreaToggleHelp: { color: COLORS.muted, fontSize: 10, marginTop: 3 },
  managementRowActions: { flexDirection: 'row', gap: 6 },
  smallNeutralButton: { height: 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  smallNeutralText: { color: '#475467', fontSize: 10, fontWeight: '800' },
  smallDangerButton: { height: 32, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: '#FDA29B', backgroundColor: COLORS.redSoft, alignItems: 'center', justifyContent: 'center' },
  smallDangerText: { color: '#B42318', fontSize: 10, fontWeight: '900' },
  tableManageChipWide: { width: '100%', minHeight: 50, paddingLeft: 11, paddingRight: 6, borderRadius: 10, borderWidth: 1, borderColor: COLORS.line, backgroundColor: '#FAFBFC', flexDirection: 'row', alignItems: 'center', gap: 7 },
  tableManageMeta: { color: COLORS.muted, fontSize: 9, marginTop: 2, fontWeight: '600' },
  tableEditButton: { height: 30, paddingHorizontal: 9, borderRadius: 8, backgroundColor: COLORS.blueSoft, borderWidth: 1, borderColor: COLORS.blueBorder, alignItems: 'center', justifyContent: 'center' },
  tableEditText: { color: COLORS.blue, fontSize: 10, fontWeight: '900' },
  logoutButton: { height: 44, borderRadius: 11, borderWidth: 1, borderColor: '#FDA29B', backgroundColor: COLORS.redSoft, alignItems: 'center', justifyContent: 'center' },
  logoutButtonText: { color: '#B42318', fontSize: 12, fontWeight: '900' },
  noteBox: { backgroundColor: '#FFFBEB', borderWidth: 1, borderColor: '#FDE68A', borderRadius: 12, padding: 10, marginBottom: 10 },
  rowNoteBadge: { alignSelf: 'flex-start', maxWidth: '98%', backgroundColor: '#FFFBDF', borderColor: '#F5D05D', borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2, marginTop: 3 },
  rowNoteText: { color: '#9A5B00', fontSize: 8.5, fontWeight: '800' },
  emptyTableHelp: { color: '#B54708', fontSize: 11, fontWeight: '700', marginBottom: 10 },
  filterSettingsToggle: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, paddingHorizontal: 10, borderRadius: 10, backgroundColor: COLORS.blueSoft },
  settingToggleLabel: { color: COLORS.text, fontSize: 12, fontWeight: '800' },
  settingToggleButton: { minWidth: 68, height: 31, borderRadius: 9, borderColor: COLORS.line, borderWidth: 1, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  settingToggleActive: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  settingToggleText: { color: '#667085', fontSize: 11, fontWeight: '800' },
  stickyModalFooter: { borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 8, backgroundColor: '#FFFFFF', flexShrink: 0 },

  noteInput: { minHeight: 70, maxHeight: 120, textAlignVertical: 'top', borderWidth: 1, borderColor: '#FDE68A', borderRadius: 9, backgroundColor: '#FFFFFF', padding: 10, color: COLORS.text, fontSize: 12 },
  noteSaveButton: { alignSelf: 'flex-end', height: 32, paddingHorizontal: 11, borderRadius: 8, backgroundColor: '#F59E0B', alignItems: 'center', justifyContent: 'center', marginTop: 7 },
  noteSaveText: { color: '#FFFFFF', fontSize: 10, fontWeight: '900' },


  statusBadge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, height: 19, alignItems: 'center', justifyContent: 'center' },
  statusText: { fontSize: 8.5, fontWeight: '900' },
  row: { minHeight: 47, borderRadius: 10, backgroundColor: '#FBFCFE', borderWidth: 1, borderColor: '#EAECF0', flexDirection: 'row', alignItems: 'center', overflow: 'hidden', paddingRight: 5 },
  statusBar: { width: 4, alignSelf: 'stretch', marginRight: 7 },
  emptyTableRow: { backgroundColor: '#FAFBFC', borderStyle: 'solid', borderColor: '#D0D5DD' },
  testDataActions: { flexDirection: 'row', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  testDataGenerateButton: { minWidth: 112, height: 46, paddingHorizontal: 20, borderWidth: 1, borderColor: COLORS.blueBorder, borderRadius: 12, backgroundColor: COLORS.blueSoft, justifyContent: 'center', alignItems: 'center' },
  testDataGenerateText: { fontSize: 14, fontWeight: '800', color: COLORS.blue },
  testDataDeleteButton: { height: 46, borderRadius: 12, borderWidth: 1, borderColor: '#FECDD3', backgroundColor: '#FFF1F2', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  testDataDeleteText: { color: '#BE123C', fontSize: 13, fontWeight: '800' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(16,24,40,0.45)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 10 },
  modalCard: { backgroundColor: COLORS.card, borderRadius: 18, padding: 18, maxHeight: '90%', shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 30, shadowOffset: { width: 0, height: 16 }, elevation: 12 },

}); }
let styles = createStyles();
