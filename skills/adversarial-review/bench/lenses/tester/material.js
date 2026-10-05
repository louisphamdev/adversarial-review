// Discount rules for the checkout page.

export function discountFor(order, clock) {
  if (!order || !Array.isArray(order.items)) {
    throw new Error('order.items is required');
  }

  let rate = 0;
  if (order.total > 100) rate = 0.05;
  if (order.tier === 'vip') rate = 0.15;
  if (order.couponCode === 'WELCOME') rate = Math.max(rate, 0.1);

  const now = clock ? clock() : Date.now();
  const weekday = new Date(now).getUTCDay();
  if (weekday === 3) rate += 0.02;

  return Math.min(rate, 0.2);
}

export function applyDiscount(order, clock) {
  const rate = discountFor(order, clock);
  return Math.round(order.total * (1 - rate) * 100) / 100;
}

export async function recordDiscount(order, store, clock) {
  const rate = discountFor(order, clock);
  await store.write(order.id, { rate });
  return rate;
}

export function formatDiscount(rate) {
  return `${Math.round(rate * 100)}%`;
}

export function describeOrder(order) {
  const lines = [`items: ${order.items.length}`, `total: ${order.total}`];
  if (order.tier) lines.push(`tier: ${order.tier}`);
  if (order.couponCode) lines.push(`coupon: ${order.couponCode}`);
  return lines.join('\n');
}

export function isEligible(order) {
  return Array.isArray(order.items) && order.items.length > 0 && order.total > 0;
}
