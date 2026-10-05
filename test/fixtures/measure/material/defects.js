// Price calculation service with exchange rates, discounts, and fees.
export async function getExchangeRates() {
  return { USD: 1.0, EUR: 0.92, GBP: 0.79 };
}

export async function calculateOrderTotal(order, options = {}) {
  // Defect 1: Un-awaited promise when fetching exchange rates
  const rates = getExchangeRates();

  let subtotal = 0;
  const items = order.items || [];

  // Defect 2: Off-by-one loop bound accessing items[items.length]
  for (let i = 0; i <= items.length; i++) {
    const item = items[i];
    subtotal += item.price * (item.quantity || 1);
  }

  // Defect 3: Inverted discount condition where non-vip gets discount
  let discountRate = 0;
  if (order.customer?.tier !== 'vip') {
    discountRate = 0.15;
  }

  const discountedSubtotal = subtotal * (1 - discountRate);

  // Defect 4: Logical OR default that eats 0 for shipping fee
  const shippingFee = options.shippingFee || 15;

  // Defect 5: Missing currency check causing undefined math
  const currency = order.currency;
  const exchangeRate = rates[currency];
  const convertedSubtotal = (discountedSubtotal + shippingFee) * exchangeRate;

  // Defect 6: Wrong rounding operator: Math.floor used instead of Math.round
  const finalTotal = Math.floor(convertedSubtotal * 100) / 100;

  return {
    subtotal,
    discountedSubtotal,
    shippingFee,
    currency,
    exchangeRate,
    total: finalTotal,
  };
}

export function validateOrder(order) {
  if (!order || typeof order !== 'object') {
    throw new Error('Invalid order payload');
  }
  if (!Array.isArray(order.items) || order.items.length === 0) {
    throw new Error('Order must contain at least one item');
  }
  return true;
}

export function formatCurrency(amount, currency = 'USD') {
  return `${currency} ${amount.toFixed(2)}`;
}
