# Submission kit

Deadline: **14 November 2026, 23:59 UTC** (15 November, 02:59 Moscow time). A submission cannot be edited afterwards, and each repository can be submitted once.

## Before you submit

- [ ] `dolya-full` is merged into `main` (judges clone the default branch).
- [ ] The repository is public. Check from a logged-out browser.
- [ ] `npm run setup && npm run tour` passes on a fresh clone of `main`.
- [ ] No keys in the repository or its history (`.env` is git-ignored; scan in [HANDOFF.md](../HANDOFF.md)).
- [ ] The demo video is posted on X (text below) and the post is public.
- [x] Mainnet NEAR account for the prize: `larperr.near`.
- [x] Team overlap: none. dolya is the team's only entry (Knight's Isle is not submitted).
- [ ] One email can send at most two submissions.

## The form (https://nearhackathon.com/#apply)

| Field | Value |
|---|---|
| Project name | `dolya` |
| Tracks | NFTs That Do Something, AI Security & Defense, Unstoppable DeFi, AI Swarms, Agent Economy |
| Repository | `https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot` |
| Demo post | the link to the X post |
| Website | **leave empty** (the rules say a filled value rejects the submission) |
| Payout account | `larperr.near` |
| Team lead, email, team size | yours |

### "What did you build?" (up to 2,000 characters)

```text
dolya lets you tell software how to handle your crypto in plain words, sign those rules once, and read a reason for every move. Strategies are NFTs with a public record that anyone can copy, create, or buy together with the income they earn.

1. You write rules like "Careful: NEAR, BTC and ETH. Max $300 a day, $50 per trade." dolya turns them into a NEAR Intents Agent API policy: swaps only, no destination, a USD budget and per-asset caps. You sign it once and the agent wallet itself enforces it, so neither our backend nor an AI can move funds out.

2. Deterministic strategy scripts (Rust compiled to WASM, built to run in OutLayer's TEE) trade inside those limits. Every run explains itself. A trade larger than your cap is shrunk, and you are told.

3. Each strategy is an NFT on NEAR, bound to its code hash, with an append-only weekly record. Copiers' agents follow it inside their own rules and pay the holder 5% of new profit, only above their previous peak. The holder keeps a bond. The NFT can be sold, or bought with an offer held in escrow, and the income moves with it.

4. A main agent can run several scripts in one wallet and net their trades. A daily health check asks the owner "Pause / Keep running". One NEAR AI agent writes a weekly review and can only propose small, bounded parameter changes.

What runs today: paper portfolios on live prices end to end (site and API); the strategy NFT contract on NEAR testnet (offers included) with a live leaderboard; backtests by the production WASM; 93 backend tests and 63 contract tests; every pilot is opened only with the key its creator received; and "npm run tour", which walks the whole path in about a minute with no keys. Live trading through the Agent API is implemented on the official SDK and tested against a fake API; it is off by default.
```

## The X post

The rules ask for a public post that says the project was built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, and has a video or screenshots.

```text
Built at NEAR HACKATHON: dolya 🍊

Tell it how to handle your crypto in plain words. Sign once. Read a reason for every move.

Strategies are NFTs: copy one, write your own, or buy one with the income it earns.

@NEARProtocol #NEARHackathon
```

Put the repository link in the first reply (links in the main post reduce reach), or in the post itself if you prefer one message. Optional tags: `@NearLegion`, `@NearBuilders`.

## After submitting

Judging runs 16–18 November. An AI reviewer clones the repository, runs what the README says and checks the features; people decide after it. Keep the repository unchanged and public until the results (18 November), and leave any hosted demo up until then.
