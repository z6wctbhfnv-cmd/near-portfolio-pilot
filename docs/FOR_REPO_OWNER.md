# For the repository owner: three steps before the deadline

Deadline: **14 November 2026, 23:59 UTC** (15 November, 02:59 Moscow time). Judges and the AI reviewer clone the default branch of a public repository.

## 1. Merge PR #15 into `main` (5 minutes)

https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot/pull/15

It contains everything: backend, the dolya site, the contract with offers, the judge tour, the README for judges. It supersedes #13 and #14. Before merging, run the team's check:

```bash
git fetch && scripts/deploy-check.sh origin/dolya-full
```

On 13 November it reported "clear". After merging, check from a fresh clone:

```bash
git clone https://github.com/z6wctbhfnv-cmd/near-portfolio-pilot /tmp/dolya && cd /tmp/dolya
npm run setup && npm run tour     # ends with 10/10 steps passed
```

## 2. Make the repository public (1 minute)

```bash
gh repo edit z6wctbhfnv-cmd/near-portfolio-pilot --visibility public --accept-visibility-change-consequences
```

Check from a logged-out browser that the page opens.

## 3. Upgrade the testnet contract and lock the bonds (10 minutes, testnet only)

This makes the two most visible features work on chain instead of saying "not yet":

- **Offers** on strategy NFTs. Today the site says they open after the contract upgrade.
- **Copying open** on chain. Today every creator bond is $0 of the $100 minimum, so the chain says copying is closed and the site copies on paper only.

The exact commands, and why the upgrade needs no migration, are in [contracts/strategy-nft/README.md](../contracts/strategy-nft/README.md#upgrade-the-deployed-contract-and-open-copying). They need the keys of `pilot-nft2-14805.testnet` and `pilot-author-10734.testnet`. Afterwards, put the new code hash into `scripts/deploy-state.env`.

Everything else for the submission (the X post, the form texts, the checklist) is in [SUBMISSION.md](SUBMISSION.md).
