// The orders, kept in memory: an order is
// { id, customerId, status, total, creditUsed, chargeId, placedAt, refundedAt }.
// `total` is the order's whole price in cents. Checkout saves every order with `status: 'placed'`.
const orders = new Map();

export function saveOrder(order) {
  orders.set(order.id, order);
  return order;
}

export function findOrder(id) {
  return orders.get(id) ?? null;
}
