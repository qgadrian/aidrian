import assert from 'node:assert/strict';
import test from 'node:test';

import { placeOrder } from './checkout.js';
import { providerCalls } from './payments.js';

test('store credit pays first and the card pays the rest', () => {
  const customer = { id: 'c1', creditCents: 1500 };
  const order = placeOrder({ id: 'o1', customer, totalCents: 4000 });
  assert.equal(order.total, 4000);
  assert.equal(order.creditUsed, 1500);
  assert.equal(customer.creditCents, 0);
  assert.equal(providerCalls().at(-1).cents, 2500);
});
