# Platform revenue: what dolya can and cannot charge

Checked on 13 Nov 2026 against the Agent API's own spec (`https://api.demo.agentsonintents.com/openapi.json`, `/llms.txt`) and the 1Click spec (`https://1click.chaindefuser.com/docs/v0/openapi.yaml`).

| Source | Rate | Status |
|---|---|---|
| Weekly fee on new profit (Pilot's share) | 0.25% of profit (0.15% when the payer was referred) | Implemented: `backend/src/fees.ts` and the NFT contract. Paper works; live works only against fakes |
| NFT sales | 0.5% of the price | In the contract (`buy`) |
| Hyperliquid builder code on perps | 0.05% of notional | Implemented on testnet orders (`backend/src/hyperliquid.ts`), when `HL_BUILDER_ADDRESS` is set |
| 1Click app fee on spot swaps | 0.10% was planned | **Not possible through the Agent API**, see below |

## 1Click app fees on spot swaps: blocked

1Click itself supports partner fees: its `POST /v0/quote` takes `appFees: [{ recipient, fee }]`, where `recipient` is a NEAR Intents account and `fee` is in basis points of `amountIn`.

The Agent API does not pass that through:
- its swap body (`POST /v1/agents/{agent_id}/swap`) has exactly `origin_asset`, `destination_asset`, `amount`, `min_amount_out`, `note`, `confidential` and `dry`, with `additionalProperties: false`. A partner field is refused with `validation_failed`;
- its docs say "1Click adds its own app fee to every order (`app_fees` on the order), which is not an API fee". The API calls 1Click itself, and the app fee there is 1Click's, not the partner's;
- the 1Click partner JWT (`NEAR_INTENTS_PARTNER_KEY`) is not an Agent API credential. The Agent API authenticates with its own `X-API-Key` from partners.demo.agentsonintents.com.

So the backend sends no app fee, and `pilot/agent_api.py` no longer sends the `app_fees` field it used to (the API would have refused every swap).

Options, none built:
1. Ask the NEAR Intents team for a partner revenue share on Agent API swaps. This is a business request.
2. Add a volume-based part to the weekly fee payment (for example 0.10% of the week's swap volume). That needs a contract change, so the split knows about it, and the owner's consent to a new fee.
3. Call 1Click directly instead of the Agent API. That would give up the signed owner policy, which is the product. Not recommended.

## Hyperliquid builder code

The builder fee goes on perp orders as `builder: { b: <address>, f: 50 }` (50 tenths of a basis point = 0.05%; Hyperliquid's cap on perps is 0.1%). Two conditions before it earns anything:
- the trading account approves the builder once, with `approveBuilderFee` signed by the **main** wallet (an API wallet cannot). Until then Hyperliquid refuses orders that carry a builder, so keep `HL_BUILDER_ADDRESS` empty until the approval is done;
- the builder address needs at least 100 USDC in its perps account.

Only testnet is wired (`HL_PERPS_ENABLED`, off by default). No order has been sent to testnet from this code: it was tested against a fake, and its signing against vectors from Hyperliquid's official Python SDK.
