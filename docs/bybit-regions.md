# Bybit regions and authentication

Select the environment where the key was actually created. The connector never retries credentials against another host automatically.

| Option                             | Fixed endpoint                  | Access                                                                                        |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| Bybit Global Testnet (.com)        | `https://api-testnet.bybit.com` | Dedicated Testnet keys, Spot trading permission; execution remains disabled in the deployment |
| Bybit EU Testnet (.eu)             | `https://api-testnet.bybit.eu`  | Keys from `testnet.bybit.eu`; Spot permissions, Testnet bots only                             |
| Bybit EU — LIVE, read-only preview | `https://api.bybit.eu`          | Account-authorized read-only preview; no bots or create/cancel orders                         |

The [EU-specific documentation repository](https://github.com/BYBIT-EU/skills) explicitly documents Testnet API-key creation at `https://testnet.bybit.eu/app/user/api-management` and the `https://api-testnet.bybit.eu` endpoint. The maintained [CCXT EU adapter](https://github.com/ccxt/ccxt/blob/master/ts/src/bybiteu.ts) and [WebSocket adapter](https://github.com/ccxt/ccxt/blob/master/ts/src/pro/bybiteu.ts) use the same regional REST and stream domains. The global integration guide's EU broker-only footnote is not sufficient guidance for EU Testnet; the prior blanket broker-only wording was incomplete. EU mainnet remains a read-only preview in this platform and still needs real account/exchange acceptance. This platform does not implement broker enrollment or OAuth authorization.

For EU Testnet, public market events use `wss://stream-testnet.bybit.eu/v5/public/spot` and private account events use `wss://stream-testnet.bybit.eu/v5/private`. Market freshness is tracked separately for global and EU feeds, so one region cannot establish freshness for the other. REST, private events, reconciliation and execution retain the connection's selected region. Both execution/master Live controls remain disabled by default. Demo Trading is a separate environment and remains unsupported.

Connecting asks for your platform password to refresh authentication immediately before testing the API key. EU mainnet additionally requires explicit acknowledgement that the connection is to a live account, and the key must be read-only. Withdrawal and transfer permissions are refused. Credentials are encrypted with tenant/connection/environment binding, never returned, and restricted to their selected host. The EU mainnet adapter blocks every POST request before transport, and bot creation still accepts only connected Testnet accounts. All live trading remains disabled.

The UI explains these exchange codes without showing raw exchange response bodies or secrets:

- `10003`: API key or environment/domain mismatch. Verify global Testnet (.com) versus EU Testnet (.eu), Demo or Live; use the exact site where the key was created.
- `10004`: signature rejected; verify the matching key/secret pair.
- `10002`: server clock outside the receive window; synchronize the Coolify host clock.
- `10005`: missing API permissions.
- `10010`: IP binding mismatch; allow the Coolify host's actual outbound IP.
- `33004`: expired API key.

These meanings follow the [official error documentation](https://bybit-exchange.github.io/docs/v5/error). A generic invalid-credentials label alone cannot establish a regional restriction. HTTP 403 may reflect exchange regional restrictions or the deployment network; the connector does not attempt to bypass either.

Local fixture tests cover signatures, endpoint separation, read-only permission checks, write rejection, acknowledgement, encryption and exclusion from bots. The cloud development environment returned HTTP 403 for an unauthenticated public Testnet probe, and the EU endpoints were unreachable, so authenticated external acceptance was not performed and no supplied keys were used. Test with fresh credentials entered directly in your deployed app, not chat. Revoke credentials shared in chat. Never enable withdrawals/transfers or use regional routing to evade exchange account/location restrictions.
