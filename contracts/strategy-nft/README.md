# strategy-nft — NEAR Portfolio Pilot strategy NFTs

NEP-171 contract (Rust, near-sdk 5.30) where **one NFT is one script**, bound to the script's `code_hash`. Deployed on testnet as [`pilot-nft2-14805.testnet`](https://testnet.nearblocks.io/address/pilot-nft2-14805.testnet).

- **Open mint.** Anyone mints for their own script (`mint_strategy`, the caller must be `info.author`) and pays the storage. A hash can be minted once.
- **Append-only record.** Only the `recorder` appends checkpoints (`append_checkpoint`), and each must carry the token's current `code_hash` and move forward in time. The record can never be rewritten.
- **Followers.** Agents `follow` a script and pay their own storage. The NFT never controls their wallets.
- **Fees.** Followers pay the holder's copy fee (0–10% of new profit, default 5%) plus the platform fee (0.25%), in a whitelisted fungible token. A referrer gets 0.1% of profit out of the platform's 0.25%. The holder on its own script pays only the 0.25%. The contract splits the payment and credits balances; `withdraw_fees` pays out. A fee raise applies only after a 7-day notice.
  - From a wallet: `ft_transfer_call` with `msg {"token_id"}`; `ft_on_transfer` splits it at once.
  - From a NEAR Intents Agent API agent, which cannot attach a `msg`: the agent withdraws plain USDC to this contract, then the recorder calls `record_fee_payment(payer, token_id, fee_token, amount, reference)`. The contract reads its own token balance and credits at most what is not already owed (`liabilities`: withdrawable balances, bonds and withdrawals in flight), once per `reference`. If a withdrawal left the contract while the balance was being read, it credits nothing and the recorder tries again. So the recorder is trusted to name the right payer and script, but it cannot make the contract owe more than it holds.
- **Sale.** `list_for_sale` / `buy`: the seller gets 99.5%, the treasury 0.5%. History, followers and future fees move to the buyer; the author stays credited.
- **Offers.** Anyone can offer their own price for a script, listed or not (`make_offer`, payable). The NEAR is held by the contract until the holder accepts (`accept_offer`, same 99.5% / 0.5% split, and any listing is removed) or the bidder cancels (`cancel_offer`, everything comes back). One offer per account and script: a new one replaces the old and refunds it. `accept_offer` names the amount, so an offer changed in the meantime is refused. The offer's storage is taken from the deposit and returned when the offer ends; the smallest offer is 0.01 NEAR.
- **Script changes.** The holder can `update_script` to a new hash: the version goes up and the change date is stored. The code never goes on chain, only its hash.

## How the backend uses it

The backend is the `recorder`. For a WASM strategy the script hash is

```
code_hash = sha256("<wasm_sha256>:<strategy_id>")
```

Once a week it appends one checkpoint per minted script: the average period return of every pilot that ran it, compounded onto the last on-chain `equity_index` (1e6 = start), with `proofs_hash` over the period's run outputs and executions. `append_checkpoint` takes no deposit, so the recorder can use a function-call key limited to that one method. See `backend/src/nft.ts`.

The recorder also credits fees that agents withdrew to the contract (`record_fee_payment`, see `backend/src/fees.ts`) and, when `NFT_REPORT_COPIED_CAPITAL=true`, reports copiers' capital (`set_copied_capital`). Both take no deposit; the recorder's function-call key must list them too.

**Not deployed yet.** `record_fee_payment`, `fee_payment`, `liabilities` and the offer methods exist only in this source: `pilot-nft2-14805.testnet` runs the previous build. See "Upgrade the deployed contract" below.

## Main methods

| Method | Who |
|---|---|
| `new(owner, recorder, treasury, fee_tokens)` | deployer |
| `mint_strategy(info, title, description)`, payable | the author |
| `append_checkpoint(token_id, checkpoint)`, `set_copied_capital(token_id, usd)` | recorder |
| `record_fee_payment(payer, token_id, fee_token, amount, reference)` | recorder (no deposit) |
| `follow(token_id)`, payable / `unfollow()` | an agent |
| `list_for_sale`, `delist`, `buy`, payable | holder / buyer |
| `make_offer(token_id)`, payable / `cancel_offer(token_id)` | a bidder |
| `accept_offer(token_id, bidder, amount)` | holder |
| `update_script(token_id, code_hash)`, `set_copy_fee`, `set_open_params`, `set_hidden` | holder |
| `withdraw_fees(fee_token)`, `withdraw_bond(...)` | fee earners / holder |
| `set_recorder`, `set_treasury`, `add_fee_token` | contract owner |
| `strategy_info`, `record`, `token_by_code_hash`, `followers`, `fee_terms`, `bond_status`, `copy_fee`, `fee_payment`, `liabilities`, `offers`, `offer_of`, `sale_price` | views |

## Build and test

`rust-toolchain.toml` pins Rust 1.95.0 (near-sdk 5.30 needs it).

```bash
cd contracts/strategy-nft
cargo test                              # 63 unit tests
cargo near build non-reproducible-wasm --no-abi  # target/near/strategy_nft.wasm (ABI generation fails on StrategyInfo/Checkpoint)
```

## Upgrade the deployed contract and open copying

For whoever holds the keys of `pilot-nft2-14805.testnet` and `pilot-author-10734.testnet`. It takes about ten minutes and changes testnet only.

**Why it is safe for the stored data.** The contract's state struct is the same as in the deployed build. The new features keep their data under storage keys the old build never used (raw keys for fees and bonds, new prefixes appended to `StorageKey` for offers), so the new code reads the old state as it is: no migration call. The contract holds no USDC, no bonds and no fee balances today (read from chain on 13 Nov 2026), so the liabilities counter correctly starts at zero.

**1. Build and deploy the code over the existing state**

```bash
cd contracts/strategy-nft
cargo near build non-reproducible-wasm --no-abi
near contract deploy pilot-nft2-14805.testnet use-file target/near/strategy_nft.wasm without-init-call network-config testnet sign-with-keychain send
```

**2. Check**

```bash
near contract call-function as-read-only pilot-nft2-14805.testnet offers json-args '{"token_id":"wasm-trend@v1"}' network-config testnet now            # [] (before the upgrade: MethodNotFound)
near contract call-function as-read-only pilot-nft2-14805.testnet revenue_receiver json-args '{"token_id":"wasm-trend@v1"}' network-config testnet now  # pilot-author-10734.testnet, as before
```

The site's leaderboard then shows the Offers block as live. Put the new code hash into `scripts/deploy-state.env` (`NFT_CODE_HASH`), or `scripts/deploy-check.sh` will report a drift.

**3. Lock the creators' bonds, so the chain says copying is open**

Each script needs a bond of at least $100 in the fee token, `usdc.fakes.testnet` (test USDC, 6 decimals; read from `fee_terms`). Today every bond is $0, and neither the contract nor the holder is registered with that token.

```bash
# register the contract and the holder with the token (0.00125 NEAR each)
near contract call-function as-transaction usdc.fakes.testnet storage_deposit json-args '{"account_id":"pilot-nft2-14805.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as pilot-author-10734.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction usdc.fakes.testnet storage_deposit json-args '{"account_id":"pilot-author-10734.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as pilot-author-10734.testnet network-config testnet sign-with-keychain send

# test USDC for the holder: the token exports a public `mint` (on Ref's test tokens its arguments are account_id and amount)
near contract call-function as-transaction usdc.fakes.testnet mint json-args '{"account_id":"pilot-author-10734.testnet","amount":"400000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as pilot-author-10734.testnet network-config testnet sign-with-keychain send

# $100 on each of wasm-rebalance@v1, wasm-trend@v1, wasm-vol-target@v1, wasm-dca@v1 (change the token id and repeat)
near contract call-function as-transaction usdc.fakes.testnet ft_transfer_call json-args '{"receiver_id":"pilot-nft2-14805.testnet","amount":"100000000","msg":"{\"token_id\":\"wasm-trend@v1\",\"bond\":true}"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as pilot-author-10734.testnet network-config testnet sign-with-keychain send

near contract call-function as-read-only pilot-nft2-14805.testnet bond_status json-args '{"token_id":"wasm-trend@v1"}' network-config testnet now   # ["100000000","100000000"]
```

After that the site and `npm run tour` show "copying is open" for those scripts instead of "the holder's bond is $0.00".

**4. If the backend should credit fees on chain:** add `record_fee_payment` and `set_copied_capital` to the recorder's function-call key.

None of these steps was run from this branch: its author had no keys for these accounts.

## Testnet accounts

| Account | Role |
|---|---|
| `pilot-nft2-14805.testnet` | contract, owner, and currently recorder and treasury |
| `pilot-author-10734.testnet` | author of the 10 listed scripts |
| `pilot-agent-10955.testnet` | demo agent |

Keys are in `~/.near-credentials/testnet/` on the developer's Mac, never in the repository.
