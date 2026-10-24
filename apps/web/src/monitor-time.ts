export function monitorTime(value: unknown) {
  if (value === null || value === undefined || value === "" || value === 0)
    return "Not recorded";
  const date =
    typeof value === "number"
      ? new Date(value)
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : "Not recorded";
}
