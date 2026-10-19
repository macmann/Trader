# Testnet acceptance and reliability milestone

The local suite uses isolated PostgreSQL and simulated exchange transports. Passing it is evidence for recovery and isolation logic, not permission to enable trading or a claim of external exchange acceptance. Both execution/live switches remain false.

## Reliability changes

Private-feed readiness requires authenticated login **and** confirmed required subscriptions, an open socket, and recent recognized traffic. Bybit subscription acknowledgements must match the connection's subscription request; OKX must acknowledge both Spot orders and account updates. Unknown traffic cannot keep a connection fresh. Authentication/subscription errors, malformed messages, disconnects and stale/future clocks invalidate readiness. Errors cause reconnect rather than leaving a failed authenticated connection cached indefinitely.

Account/order/execution messages advance a connection-local revision. An execution path captures the revision before REST reconciliation and checks it again immediately before submission, including across committed order markers. A private account change during the checks prevents sending the old intent. This is a conservative reconciliation fence; private event payloads are not yet an authoritative direct-fill ledger. REST remains authoritative and must succeed before new entries resume after reconnect.

Reconciliation rejects malformed pages/cursors, untracked executions, contradictory order identity, invalid fill identifiers/timestamps, wrong symbol/side, unsupported execution types and nonzero fees with no currency. Repeated execution IDs must match the original order, quantity, price, fee, currency and timestamp. A changed duplicate rolls back the transaction instead of silently changing financial history. Unknown exchange states retain reservations and block new entries. A fully Filled order must report the expected quantity, and terminal status still requires all matching fills. Bybit's PartiallyFilledCanceled status releases only its remaining reservation after those fills are applied; the filled inventory remains owned by the bot.

Simulated tests also run two independent tenant bots concurrently, reconcile the same exchange execution ID in each tenant, and prove stopping one leaves the other running. Existing crash/timeout, pagination, cancellation, fee and portfolio tests remain in force.

## Read-only preflight

Run:

```sh
npm run testnet:preflight
```

The command probes the public Bybit Testnet instrument endpoint, checks the restricted runtime role and execution switches, then reads Testnet connections from personal workspaces. For stored credentials it performs server-side permission, balance and open-order reads only. It never creates/cancels orders, modifies bot status, sends messages, calls Live adapters or changes execution flags. Database transactions are read-only. It does not print keys, secrets, balances, emails, raw exchange errors or account identifiers.

The sanitized JSON report is printed and saved to ignored `.local/testnet-preflight.json`. Exit 0 means only these read-only prerequisites passed; exit 2 means blocked. `acceptanceComplete` is always false: this command cannot prove distinct underlying exchange accounts, private-stream operation, fills/fees or recovery by placing orders. Two records in one workspace do not satisfy its two-user requirement. A successful HTTP response with malformed instrument data does not count as access success.

Current instance result: public Bybit Testnet instrument access returned HTTP 403; no connected personal Testnet workspaces were found. The runtime role enforces RLS. No external orders were placed. HTTP 403 proves an access failure, not whether the exchange or environment policy denied it.

## Prerequisites for external acceptance

1. In cloud environment settings, permit the intended public/private Bybit Testnet destinations (`api-testnet.bybit.com`, `stream-testnet.bybit.com`) while preserving existing network policy. Do not bypass exchange regional restrictions. Optional OKX validation requires its documented hosts separately.
2. Register and verify two users and connect separate, dedicated, user-owned Bybit Testnet accounts through the app. Use read/Spot-trading keys with no withdrawals or transfers. Never put exchange secrets in chat or a platform-wide trading key in `.env`.
3. Rerun the read-only preflight and resolve permission, ledger, stale-data and unknown-order problems. Dedicated clean Testnet accounts avoid unexplained existing execution history; do not discard a real ledger merely to make a check pass.
4. Finish and verify an exchange-native protective-order workflow, precise daily-equity accounting, production operations and the release gates in phase-1.md before intentionally enabling submission. This milestone does not enable that flag.

## External evidence matrix — still unrun

| Scenario       | Required evidence                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two accounts   | Two separate underlying account identities, independent credential validation/private streams, no cross-tenant API visibility                        |
| Bounded orders | $100 bot allocation and $20 maximum trade checked against exchange fills, base/quote fees, balances and local P&L                                    |
| Stop/pause     | Stop one bot while the other continues; pending-entry cancellation confirmed before budget release; existing inventory behavior recorded             |
| Crash windows  | Restart before intent commit, after intent commit, after attempted-send commit, during acknowledgement and during partial fill                       |
| Network faults | Lost REST response, stale public feed, private subscription rejection, disconnect/reconnect, account change during reconciliation, rate limit/outage |
| Reconciliation | Pagination, missing fills, changed duplicate IDs, manual/unknown orders or executions, partial cancellation, unsupported fees and long downtime      |
| Protection     | Verified native protection and software fallback behavior during worker/database/network outages                                                     |

For each external run record the application commit, provider/environment, scenario, sanitized order reference, expected/actual result and timestamp. Keep secret-bearing exchange exports private. Report pass/fail/unrun separately; do not promote simulator results into verified live performance.
