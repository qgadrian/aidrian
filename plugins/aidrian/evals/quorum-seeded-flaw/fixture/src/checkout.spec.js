import assert from 'node:assert/strict';
import test from 'node:test';

import { placeOrder } from './checkout.js';
import { findOrder } from './orders.js';
import { providerCalls } from './payments.js';

test('store credit pays first and the card pays the rest', () => {
  const customer = { id: 'c1', creditCents: 1500 };
  const order = placeOrder({ id: 'o1', customer, totalCents: 4000 });
  assert.equal(order.total, 4000);
  assert.equal(order.status, 'placed');
  assert.equal(findOrder('o1'), order);
  assert.equal(order.creditUsed, 1500);
  assert.equal(customer.creditCents, 0);
  assert.equal(providerCalls().at(-1).cents, 2500);
});

test('a retried order takes no store credit and no charge again', () => {
  const customer = { id: 'c2', creditCents: 1500 };
  const first = placeOrder({ id: 'o2', customer, totalCents: 1000 });
  const calls = providerCalls().length;
  const again = placeOrder({ id: 'o2', customer, totalCents: 1000 });
  assert.equal(again, first);
  assert.equal(customer.creditCents, 500);
  assert.equal(providerCalls().length, calls);
});
