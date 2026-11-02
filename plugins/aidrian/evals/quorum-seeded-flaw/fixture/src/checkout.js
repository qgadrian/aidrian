import { findOrder, saveOrder } from './orders.js';
import { charge } from './payments.js';

// Store credit pays first; the card pays the rest. A retry of an order already placed returns that order, and takes
// no credit and no charge again.
export function placeOrder({ id, customer, totalCents, now = new Date() }) {
  const placed = findOrder(id);
  if (placed) return placed;
  const creditUsed = Math.min(customer.creditCents, totalCents);
  customer.creditCents -= creditUsed;
  const chargeId = charge(id, customer.id, totalCents - creditUsed);
  return saveOrder({
    id, customerId: customer.id, status: 'placed', total: totalCents, creditUsed, chargeId,
    placedAt: now.toISOString(), refundedAt: null,
  });
}
