# strategy-nft — NEAR Portfolio Pilot strategy NFTs

NEP-171 contract (Rust, near-sdk 5.30) where **one NFT is one script**, bound to the script's `code_hash`. Deployed on testnet as [`pilot-nft2-14805.testnet`](https://testnet.nearblocks.io/address/pilot-nft2-14805.testnet).

- **Open mint.** Anyone mints for their own script (`mint_strategy`, the caller must be `info.author`) and pays the storage. A hash can be minted once.
- **Append-only record.** Only the `recorder` appends checkpoints (`append_checkpoint`), and each must carry the token's current `code_hash` and move forward in time. The record can never be rewritten.
- **Followers.** Agents `follow` a script and pay their own storage. The NFT never controls their wallets.
- **Fees.** Followers pay the holder's copy fee (0–10% of new profit, default 5%) plus the platform fee (0.25%), in a whitelisted fungible token. A referrer gets 0.1% of profit out of the platform's 0.25%. The holder on its own script pays only the 0.25%. The contract splits the payment and credits balances; `withdraw_fees` pays out. A fee raise applies only after a 7-day notice.
  - From a wallet: `ft_transfer_call` with `msg {"token_id"}`; `ft_on_transfer` splits it at once.
  - From a NEAR Intents Agent API agent, which cannot attach a `msg`: the agent withdraws plain USDC to this contract, then the recorder calls `record_fee_payment(payer, token_id, fee_token, amount, reference)`. The contract reads its own token balance and credits at most what is not already owed (`liabilities`: withdrawable balances, bonds and withdrawals in flight), once per `reference`. If a withdrawal left the contract while the balance was being read, it credits nothing and the recorder tries again. So the recorder is trusted to name the right payer and script, but it cannot make the contract owe more than it holds.
- **Sale.** `list_for_sale` / `buy`: the seller gets 99.5%, the treasury 0.5%. History, followers and future fees move to the buyer; the author stays credited.
- **Script changes.** The holder can `update_script` to a new hash: the version goes up and the change date is stored. The code never goes on chain, only its hash.

## How the backend uses it

The backend is the `recorder`. For a WASM strategy the script hash is

```
code_hash = sha256("<wasm_sha256>:<strategy_id>")
```

Once a week it appends one checkpoint per minted script: the average period return of every pilot that ran it, compounded onto the last on-chain `equity_index` (1e6 = start), with `proofs_hash` over the period's run outputs and executions. `append_checkpoint` takes no deposit, so the recorder can use a function-call key limited to that one method. See `backend/src/nft.ts`.

The recorder also credits fees that agents withdrew to the contract (`record_fee_payment`, see `backend/src/fees.ts`) and, when `NFT_REPORT_COPIED_CAPITAL=true`, reports copiers' capital (`set_copied_capital`). Both take no deposit; the recorder's function-call key must list them too.

**Not deployed yet.** `record_fee_payment`, `fee_payment` and `liabilities` exist only in this source: `pilot-nft2-14805.testnet` runs the previous build. That contract holds no USDC, bonds or fee balances (checked 13 Nov 2026), so a code upgrade there needs no migration; a contract that already holds balances must start fresh, because the liabilities counter starts at zero.

## Main methods

| Method | Who |
|---|---|
| `new(owner, recorder, treasury, fee_tokens)` | deployer |
| `mint_strategy(info, title, description)`, payable | the author |
| `append_checkpoint(token_id, checkpoint)`, `set_copied_capital(token_id, usd)` | recorder |
| `record_fee_payment(payer, token_id, fee_token, amount, reference)` | recorder (no deposit) |
| `follow(token_id)`, payable / `unfollow()` | an agent |
| `list_for_sale`, `delist`, `buy`, payable | holder / buyer |
| `update_script(token_id, code_hash)`, `set_copy_fee`, `set_open_params`, `set_hidden` | holder |
| `withdraw_fees(fee_token)`, `withdraw_bond(...)` | fee earners / holder |
| `set_recorder`, `set_treasury`, `add_fee_token` | contract owner |
| `strategy_info`, `record`, `token_by_code_hash`, `followers`, `fee_terms`, `bond_status`, `copy_fee`, `fee_payment`, `liabilities` | views |

## Build and test

`rust-toolchain.toml` pins Rust 1.95.0 (near-sdk 5.30 needs it).

```bash
cd contracts/strategy-nft
cargo test                              # 54 unit tests
cargo near build non-reproducible-wasm --no-abi  # target/near/strategy_nft.wasm (ABI generation fails on StrategyInfo/Checkpoint)
```

## Testnet accounts

| Account | Role |
|---|---|
| `pilot-nft2-14805.testnet` | contract, owner, and currently recorder and treasury |
| `pilot-author-10734.testnet` | author of the 10 listed scripts |
| `pilot-agent-10955.testnet` | demo agent |

Keys are in `~/.near-credentials/testnet/` on the developer's Mac, never in the repository.
