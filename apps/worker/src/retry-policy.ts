import { ExchangeError } from "../../../packages/core/src/index.ts";
export function transientExchangeFailure(error: unknown): boolean {
  return (
    error instanceof ExchangeError &&
    (error.status === "RATE_LIMITED" ||
      (error.status === "EXCHANGE_HTTP_ERROR" &&
        [408, 500, 502, 503, 504].includes(error.code)))
  );
}
// Connection scope prevents a second bot from immediately repeating a failed account request.
export class RetryPolicy {
  private entries = new Map<string, { attempts: number; until: number }>();
  ready(key: string, now = Date.now()) {
    return (this.entries.get(key)?.until ?? 0) <= now;
  }
  success(key: string) {
    this.entries.delete(key);
  }
  failure(key: string, now = Date.now()) {
    const attempts = (this.entries.get(key)?.attempts ?? 0) + 1;
    const until =
      now + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4));
    this.entries.set(key, { attempts, until });
    return until;
  }
}
