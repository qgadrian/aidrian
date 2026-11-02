// The card provider's client. Every call carries an idempotency key; the provider runs a repeated key once.
const calls = [];

export function charge(orderId, customerId, cents) {
  if (cents === 0) return null;
  const chargeId = `ch_${orderId}`;
  calls.push({ kind: 'charge', customerId, cents, chargeId, idempotencyKey: `charge:${orderId}` });
  return chargeId;
}

export function refund(chargeId, cents) {
  calls.push({ kind: 'refund', chargeId, cents, idempotencyKey: `refund:${chargeId}` });
}

export function providerCalls() {
  return calls;
}
