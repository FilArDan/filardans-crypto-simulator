// ===== УТИЛИТЫ =====
export const fmt   = n => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
export const fmtC  = n => Number(n).toFixed(4);
export const fmtLarge = n => {
  if(n>=1e12) return (n/1e12).toFixed(2)+'T';
  if(n>=1e9)  return (n/1e9).toFixed(2)+'B';
  if(n>=1e6)  return (n/1e6).toFixed(2)+'M';
  return fmt(n);
};
export const portV = (held, coins) => Object.keys(held).reduce((s,k) => s + held[k] * (coins[k]?.price ?? 0), 0);
