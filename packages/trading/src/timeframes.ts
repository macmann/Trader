export const timeframeValues = ["5", "15", "30", "60", "240", "1440"] as const;
export const timeframeLabels = ["5m", "15m", "30m", "1h", "4h", "1d"] as const;
export const timeframes = timeframeValues.map((value, index) => ({
  value,
  label: timeframeLabels[index],
}));
export function timeframeLabel(value: string) {
  const index = (timeframeValues as readonly string[]).indexOf(value);
  if (index < 0) throw Error("UNSUPPORTED_TIMEFRAME");
  return timeframeLabels[index];
}
export function timeframeValue(label: string) {
  const index = (timeframeLabels as readonly string[]).indexOf(label);
  if (index < 0) throw Error("UNSUPPORTED_TIMEFRAME");
  return timeframeValues[index];
}
export function bybitInterval(value: string) {
  timeframeLabel(value);
  return value === "1440" ? "D" : value;
}
export function okxInterval(value: string) {
  const label = timeframeLabel(value);
  return label === "1d"
    ? "1Dutc"
    : label.endsWith("h")
      ? label.toUpperCase()
      : label;
}
