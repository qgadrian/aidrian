// The card provider's client. Every call carries an idempotency key; the provider runs a repeated key once.
const calls = [];

export function charge(customerId, cents) {
  if (cents === 0) return null;
  const chargeId = `ch_${calls.length + 1}`;
  calls.push({ kind: 'charge', customerId, cents, chargeId, idempotencyKey: `charge:${customerId}:${calls.length}` });
  return chargeId;
}

export function refund(chargeId, cents) {
  calls.push({ kind: 'refund', chargeId, cents, idempotencyKey: `refund:${chargeId}` });
}

export function providerCalls() {
  return calls;
}
