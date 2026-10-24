# Bybit regions and authentication

Select the environment where the key was actually created. The connector never retries credentials against another host automatically.

| Option                             | Fixed endpoint                  | Access                                                                                        |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| Bybit Testnet                      | `https://api-testnet.bybit.com` | Dedicated Testnet keys, Spot trading permission; execution remains disabled in the deployment |
| Bybit EU — LIVE, read-only preview | `https://api.bybit.eu`          | Broker-authorized EU read-only API access only; no bots or create/cancel orders               |

Bybit's [official integration guide](https://bybit-exchange.github.io/docs/v5/guide) specifies the EU mainnet domain and states that EU API access supports the "Connect to Third-Party Applications" feature for API broker users. An ordinary self-generated EU key may not work. This preview adds endpoint routing and read-only validation; it does not implement broker enrollment, OAuth authorization or live execution. Broker/account/exchange approval and real EU acceptance remain prerequisites. A Testnet key is not an EU live key. Bybit Demo credentials are also separate and are not supported by this connector.

Connecting asks for your platform password to refresh authentication immediately before testing the API key. EU additionally requires explicit acknowledgement that the connection is to a live account, and the key must be read-only. Withdrawal and transfer permissions are refused. Credentials are encrypted with tenant/connection/environment binding, never returned, and restricted to their selected host. The EU adapter blocks every POST request before transport, and bot creation still accepts only connected Testnet accounts. Global live trading remains disabled.

The UI explains these exchange codes without showing raw exchange response bodies or secrets:

- `10003`: API key or environment/domain mismatch. Verify Testnet versus Demo versus global/EU Live; EU broker restrictions may also apply.
- `10004`: signature rejected; verify the matching key/secret pair.
- `10002`: server clock outside the receive window; synchronize the Coolify host clock.
- `10005`: missing API permissions.
- `10010`: IP binding mismatch; allow the Coolify host's actual outbound IP.
- `33004`: expired API key.

These meanings follow the [official error documentation](https://bybit-exchange.github.io/docs/v5/error). A generic invalid-credentials label alone cannot establish a regional restriction. HTTP 403 may reflect exchange regional restrictions or the deployment network; the connector does not attempt to bypass either.

Local fixture tests cover signatures, endpoint separation, read-only permission checks, write rejection, acknowledgement, encryption and exclusion from bots. The cloud development environment returned HTTP 403 for an unauthenticated public Testnet probe, so authenticated external acceptance was not performed and no supplied keys were used. Test with fresh credentials entered directly in your deployed app, not chat. Revoke credentials shared in chat. Never enable withdrawals/transfers or use regional routing to evade exchange account/location restrictions.
