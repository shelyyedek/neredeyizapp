// Saatli Masa iş kuralları; React Native'den bağımsız test edilebilir.
const isClockReservation = (reservation, areas) =>
  Array.isArray(areas) && areas.some((area) => area.id === reservation?.areaId && area.clockArea === true);

function clockExpiryDate(reservation) {
  const date = String(reservation?.date || '');
  const time = String(reservation?.endTime || reservation?.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const result = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) return null;
  return result;
}

function isClockReservationLate(reservation, now = new Date()) {
  if (!reservation || reservation.status === 'cancelled' || reservation.testData === true) return false;
  const expiry = clockExpiryDate(reservation);
  return !!expiry && now.getTime() >= expiry.getTime();
}

module.exports = { isClockReservation, clockExpiryDate, isClockReservationLate };
