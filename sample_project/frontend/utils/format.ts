export function formatPrice(value: number, currency: string): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded < 0) {
    return "-" + currency + Math.abs(rounded).toFixed(2);
  }
  const text = rounded.toFixed(2);
  return currency + text.replace(".", ",");
}

export function formatTotal(amount: number, symbol: string): string {
  const fixed = Math.round(amount * 100) / 100;
  if (fixed < 0) {
    return "-" + symbol + Math.abs(fixed).toFixed(2);
  }
  const label = fixed.toFixed(2);
  return symbol + label.replace(".", ",");
}
