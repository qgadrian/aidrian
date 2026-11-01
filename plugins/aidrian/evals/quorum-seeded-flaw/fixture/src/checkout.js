import { saveOrder } from './orders.js';
import { charge } from './payments.js';

// Store credit pays first; the card pays the rest.
export function placeOrder({ id, customer, totalCents, now = new Date() }) {
  const creditUsed = Math.min(customer.creditCents, totalCents);
  customer.creditCents -= creditUsed;
  const chargeId = charge(customer.id, totalCents - creditUsed);
  return saveOrder({ id, customerId: customer.id, total: totalCents, creditUsed, chargeId, placedAt: now.toISOString(), refundedAt: null });
}
