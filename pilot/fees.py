"""Weekly fees on new profit, matching the strategy NFT contract.

- A follower pays 5% of its new profit to the script's NFT holder and 0.25% to Pilot.
- The holder trading its own script pays only 0.25% to Pilot.
- If the payer was referred, 0.1% of profit (out of Pilot's 0.25%) goes to the referrer.
- "New profit" is equity above the agent's previous peak after fees (high-water mark): no profit,
  no fee, and a loss must be recovered before fees are charged again.

The pilot sends the total with `ft_transfer_call` to the NFT contract, msg {"token_id": ...};
the contract splits it and credits the holder, the referrer and the treasury.
"""
from __future__ import annotations

from dataclasses import dataclass

HOLDER_FEE = 0.05  # default; each script's holder sets 0..10% (contract: set_copy_fee)
MAX_HOLDER_FEE = 0.10
PLATFORM_FEE = 0.0025
REFERRAL_FEE = 0.001  # out of PLATFORM_FEE, only when the payer has a referrer


@dataclass
class FeeCharge:
    profit: float  # new profit above the high-water mark
    to_holders: dict[str, float]  # script id -> USD for that script's NFT holder
    to_platform: float  # Pilot's net share, after the referral part
    to_referrer: float = 0.0

    @property
    def total(self) -> float:
        return sum(self.to_holders.values()) + self.to_platform + self.to_referrer


@dataclass
class HighWaterMark:
    peak: float

    def charge(self, equity: float, alloc: dict[str, float], own: frozenset[str] = frozenset(),
               referred: bool = False, rates: dict[str, float] | None = None) -> FeeCharge:
        """Fee for this period. `alloc`: script id -> share of capital it ran (sums to <= 1).

        Profit is attributed to scripts by their share; the unallocated part (cash) pays only Pilot.
        Scripts in `own` belong to this agent's owner, so no holder fee is due on them.
        """
        profit = max(0.0, equity - self.peak)
        if profit <= 0:
            return FeeCharge(0.0, {}, 0.0)
        rates = rates or {}
        for sid, r in rates.items():
            if not 0 <= r <= MAX_HOLDER_FEE:
                raise ValueError(f"{sid}: copy fee {r:.2%} outside 0..10%")
        to_holders = {sid: profit * share * rates.get(sid, HOLDER_FEE) for sid, share in alloc.items()
                      if share > 0 and sid not in own and rates.get(sid, HOLDER_FEE) > 0}
        ref = profit * REFERRAL_FEE if referred else 0.0
        charge = FeeCharge(profit, to_holders, profit * PLATFORM_FEE - ref, ref)
        self.peak = equity - charge.total  # the peak is measured after fees, as paid
        return charge
