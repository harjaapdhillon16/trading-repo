export const formatUsd = (value: number) => {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  return formatter.format(value);
};

export const formatNumber = (value: number, digits = 2) => {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value);
};

export const formatPercent = (value: number, digits = 1) => {
  return `${formatNumber(value * 100, digits)}%`;
};

export const formatSeconds = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0s";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
};
