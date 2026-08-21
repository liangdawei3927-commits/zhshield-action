export function formatMoney(amount: number, currency: string): string {
  const normalized = Number.isFinite(amount) ? amount : 0;
  const negative = normalized < 0;
  const absolute = Math.abs(normalized);
  const whole = Math.floor(absolute);
  const fraction = Math.round((absolute - whole) * 100);
  const withFraction = fraction === 0 ? `${whole}.00` : `${whole}.${fraction < 10 ? `0${fraction}` : fraction}`;
  const grouped = withFraction.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const prefix = currency === 'JPY' || currency === 'KRW' ? '' : `${currency} `;
  const sign = negative ? '-' : '';
  return `${sign}${prefix}${grouped}`;
}

export function sumLineItems(prices: number[]): number {
  return prices.reduce((total, price) => total + price, 0);
}
