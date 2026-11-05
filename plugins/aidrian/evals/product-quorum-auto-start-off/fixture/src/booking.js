// Cancelling a booking. A cancelled booking stays on the sheet, and its slot stays taken until something frees it.
export function cancel(booking, sheet) {
  booking.status = 'cancelled';
  sheet.push({ booking: booking.id, line: 'cancelled' });
  return booking;
}
