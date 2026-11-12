# strategy-nft — NEAR Portfolio Pilot strategy NFTs

NEP-171 contract (Rust, near-sdk 5.30) where **one NFT is one script**, bound to the script's `code_hash`. Deployed on testnet as [`pilot-nft2-14805.testnet`](https://testnet.nearblocks.io/address/pilot-nft2-14805.testnet).

- **Open mint.** Anyone mints for their own script (`mint_strategy`, the caller must be `info.author`) and pays the storage. A hash can be minted once.
- **Append-only record.** Only the `recorder` appends checkpoints (`append_checkpoint`), and each must carry the token's current `code_hash` and move forward in time. The record can never be rewritten.
- **Followers.** Agents `follow` a script and pay their own storage. The NFT never controls their wallets.
- **Fees.** Followers pay the holder's copy fee (0–10% of new profit, default 5%) plus the platform fee, in a whitelisted fungible token through `ft_transfer_call`. The contract splits the payment and credits balances; `withdraw_fees` pays out. A fee raise applies only after a 7-day notice.
- **Sale.** `list_for_sale` / `buy`: the seller gets 99.5%, the treasury 0.5%. History, followers and future fees move to the buyer; the author stays credited.
- **Script changes.** The holder can `update_script` to a new hash: the version goes up and the change date is stored. The code never goes on chain, only its hash.

## How the backend uses it

The backend is the `recorder`. For a WASM strategy the script hash is

```
code_hash = sha256("<wasm_sha256>:<strategy_id>")
```

Once a week it appends one checkpoint per minted script: the average period return of every pilot that ran it, compounded onto the last on-chain `equity_index` (1e6 = start), with `proofs_hash` over the period's run outputs and executions. `append_checkpoint` takes no deposit, so the recorder can use a function-call key limited to that one method. See `backend/src/nft.ts`.

## Main methods

| Method | Who |
|---|---|
| `new(owner, recorder, treasury, fee_tokens)` | deployer |
| `mint_strategy(info, title, description)`, payable | the author |
| `append_checkpoint(token_id, checkpoint)` | recorder |
| `follow(token_id)`, payable / `unfollow()` | an agent |
| `list_for_sale`, `delist`, `buy`, payable | holder / buyer |
| `update_script(token_id, code_hash)`, `set_copy_fee`, `set_open_params`, `set_hidden` | holder |
| `withdraw_fees(fee_token)`, `withdraw_bond(...)` | fee earners / holder |
| `set_recorder`, `set_treasury`, `add_fee_token` | contract owner |
| `strategy_info`, `record`, `token_by_code_hash`, `followers`, `fee_terms`, `bond_status`, `copy_fee` | views |

## Build and test

`rust-toolchain.toml` pins Rust 1.95.0 (near-sdk 5.30 needs it).

```bash
cd contracts/strategy-nft
cargo test                              # 42 unit tests
cargo near build non-reproducible-wasm  # target/near/strategy_nft.wasm
```

## Testnet accounts

| Account | Role |
|---|---|
| `pilot-nft2-14805.testnet` | contract, owner, and currently recorder and treasury |
| `pilot-author-10734.testnet` | author of the 10 listed scripts |
| `pilot-agent-10955.testnet` | demo agent |

Keys are in `~/.near-credentials/testnet/` on the developer's Mac, never in the repository.
