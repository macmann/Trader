// Connection-local state: authentication alone never authorizes trading.
export class PrivateFeedState {
  authenticated = false;
  failed = false;
  lastMessage = 0;
  revision = 0;
  private subscriptions = new Set<string>();
  constructor(
    readonly provider: "BYBIT" | "BYBIT_EU_TESTNET" | "OKX",
    readonly futures = false,
  ) {}
  invalidate() {
    this.failed = true;
    this.authenticated = false;
    this.subscriptions.clear();
    this.revision++;
  }
  ready(now = Date.now()) {
    return (
      !this.failed &&
      this.authenticated &&
      this.subscriptions.has("orders") &&
      this.subscriptions.has("account") &&
      now >= this.lastMessage &&
      now - this.lastMessage < 45000
    );
  }
  futuresReady(now = Date.now()) {
    return this.ready(now) && this.subscriptions.has("positions");
  }
  receive(
    raw: string,
    now = Date.now(),
  ): "AUTHENTICATED" | "EVENT" | "HEARTBEAT" | "ACK" | "IGNORE" {
    try {
      if (this.failed) return "IGNORE";
      if (this.provider === "OKX" && raw === "pong") {
        if (this.authenticated) {
          this.lastMessage = now;
          return "HEARTBEAT";
        }
        return "IGNORE";
      }
      const m = JSON.parse(raw);
      if (!m || typeof m !== "object" || Array.isArray(m)) throw Error();
      if (this.provider !== "OKX") {
        if (m.op === "auth") {
          if (m.success !== true) throw Error();
          this.authenticated = true;
          this.lastMessage = now;
          return "AUTHENTICATED";
        }
        if (m.op === "subscribe") {
          if (
            !this.authenticated ||
            m.success !== true ||
            m.req_id !== "private-subscriptions"
          )
            throw Error();
          this.subscriptions.add("orders");
          this.subscriptions.add("account");
          if (this.futures) this.subscriptions.add("positions");
          this.lastMessage = now;
          return "ACK";
        }
        if (
          m.op === "pong" ||
          (m.op === "ping" && m.ret_msg === "pong" && m.success !== false)
        ) {
          if (this.authenticated) {
            this.lastMessage = now;
            return "HEARTBEAT";
          }
          return "IGNORE";
        }
        if (["order", "execution", "wallet", "position"].includes(m.topic)) {
          if (!this.authenticated || !Array.isArray(m.data)) throw Error();
          this.revision++;
          this.lastMessage = now;
          return "EVENT";
        }
        if (m.success === false || m.op === "error") throw Error();
      } else {
        if (m.event === "error") throw Error();
        if (m.event === "login") {
          if (m.code !== "0") throw Error();
          this.authenticated = true;
          this.lastMessage = now;
          return "AUTHENTICATED";
        }
        if (m.event === "subscribe") {
          if (!this.authenticated || (m.code !== undefined && m.code !== "0"))
            throw Error();
          if (
            m.arg?.channel === "orders" &&
            ["SPOT", "SWAP", "ANY"].includes(m.arg.instType)
          )
            this.subscriptions.add("orders");
          else if (m.arg?.channel === "positions")
            this.subscriptions.add("positions");
          else if (m.arg?.channel === "account")
            this.subscriptions.add("account");
          else throw Error();
          this.lastMessage = now;
          return "ACK";
        }
        if (
          ["orders", "account", "positions"].includes(m.arg?.channel) &&
          m.data !== undefined
        ) {
          if (!this.authenticated || !Array.isArray(m.data)) throw Error();
          this.revision++;
          this.lastMessage = now;
          return "EVENT";
        }
      }
      return "IGNORE";
    } catch {
      this.invalidate();
      return "IGNORE";
    }
  }
}
