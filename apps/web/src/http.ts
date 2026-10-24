export function jsonRequestOptions(
  method: string,
  csrf: string,
  data?: unknown,
) {
  const body = data === undefined ? undefined : JSON.stringify(data);
  const headers: Record<string, string> = { "X-CSRF-Token": csrf };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return { method, headers, body };
}
