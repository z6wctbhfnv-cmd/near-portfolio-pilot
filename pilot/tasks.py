"""Owner tasks for the main agent: conditional orders and recurring buys.

    "if BTC below 60000 buy $500"            -> Conditional(asset=BTC, op="<", price=60000, side=buy, usd=500)
    "если ETH выше 4000 продай на $300"      -> Conditional(asset=ETH, op=">", price=4000, side=sell, usd=300)
    "buy $50 of ETH every friday"            -> Recurring(asset=ETH, side=buy, usd=50, weekday=4)
    "каждый день покупай BTC на $20"          -> Recurring(asset=BTC, side=buy, usd=20, weekday=None)

Tasks only produce order requests. Every request still goes through the signed policy
(`PolicyState.check`), so a task can never do what the owner's rules forbid.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

import pandas as pd

ASSETS = {"btc": "BTC", "bitcoin": "BTC", "биткоин": "BTC", "eth": "ETH", "ether": "ETH", "эфир": "ETH",
          "sol": "SOL", "solana": "SOL", "near": "NEAR", "gold": "XAUT", "xaut": "XAUT", "золото": "XAUT"}
WEEKDAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
            "понедельник": 0, "вторник": 1, "сред": 2, "четверг": 3, "пятниц": 4, "суббот": 5, "воскресен": 6}
_NUM = r"(\d[\d,\s]*(?:\.\d+)?)\s*(k|к)?"


@dataclass
class Order:
    side: str  # buy | sell
    asset: str
    usd: float
    reason: str


@dataclass
class Conditional:
    asset: str
    op: str  # "<" or ">"
    price: float
    side: str
    usd: float
    done: bool = False
    kind: str = field(default="conditional", init=False)

    def due(self, ts: int, px: dict[str, float]) -> Order | None:
        if self.done or self.asset not in px:
            return None
        hit = px[self.asset] < self.price if self.op == "<" else px[self.asset] > self.price
        if not hit:
            return None
        self.done = True  # one-shot: fires once, then stays done
        return Order(self.side, self.asset, self.usd, f"{self.asset} {self.op} {self.price:,.0f}")


@dataclass
class Recurring:
    asset: str
    side: str
    usd: float
    weekday: int | None  # None = every day
    last_day: int | None = None
    kind: str = field(default="recurring", init=False)

    def due(self, ts: int, px: dict[str, float]) -> Order | None:
        t = pd.Timestamp(ts, unit="ms", tz="UTC")
        day = int(ts // 86_400_000)
        if self.last_day == day or (self.weekday is not None and t.weekday() != self.weekday):
            return None
        self.last_day = day
        when = "daily" if self.weekday is None else f"every {t.day_name()}"
        return Order(self.side, self.asset, self.usd, f"{when} {self.side} ${self.usd:,.0f}")


Task = Conditional | Recurring


def _num(m: re.Match) -> float:
    v = float(m.group(1).replace(",", "").replace(" ", ""))
    return v * 1000 if m.group(2) else v


def _asset(text: str) -> str | None:
    for k, v in ASSETS.items():
        if re.search(rf"\b{k}", text):
            return v
    return None


def _side(text: str) -> str | None:
    if re.search(r"\b(sell|продай|продавай)", text):
        return "sell"
    if re.search(r"\b(buy|купи|покупай|докупай)", text):
        return "buy"
    return None


def parse_task(text: str) -> Task:
    """Words -> one task. Raises ValueError with a readable reason when something is missing."""
    t = text.lower()
    asset, side = _asset(t), _side(t)
    usd_m = re.search(rf"\$\s*{_NUM}|{_NUM}\s*(?:\$|usd|usdc|долл)", t)
    usd = None
    if usd_m:
        g = usd_m.groups()
        usd = float((g[0] or g[2]).replace(",", "").replace(" ", "")) * (1000 if (g[1] or g[3]) else 1)
    if not (asset and side and usd):
        raise ValueError("need an asset, buy or sell, and a dollar amount, e.g. 'if BTC below 60000 buy $500'")
    if usd <= 0 or usd > 1_000_000:
        raise ValueError("amount must be between $0 and $1,000,000")
    cond = re.search(rf"(below|under|less than|ниже|меньше|above|over|more than|выше|больше)\s*\$?\s*{_NUM}", t)
    if cond and re.search(r"\b(if|when|если|когда)\b", t):
        op = "<" if re.match(r"below|under|less|ниже|меньше", cond.group(1)) else ">"
        return Conditional(asset, op, _num(re.match(_NUM, cond.group(0)[len(cond.group(1)):].strip().lstrip("$").strip())), side, usd)
    if re.search(r"every|each|каждый|каждую|каждое|ежедневно|daily|weekly", t):
        wd = next((v for k, v in WEEKDAYS.items() if k in t), None)
        return Recurring(asset, side, usd, wd)
    raise ValueError("say when: 'if BTC below 60000 …' or 'every friday …'")


def describe(task: Task) -> str:
    if isinstance(task, Conditional):
        return f"When {task.asset} is {'below' if task.op == '<' else 'above'} ${task.price:,.0f}: {task.side} ${task.usd:,.0f} once"
    days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    when = "every day" if task.weekday is None else f"every {days[task.weekday]}"
    return f"{task.side.capitalize()} ${task.usd:,.0f} of {task.asset} {when}"


def as_dict(task: Task) -> dict:
    return {**asdict(task), "kind": task.kind, "text": describe(task)}
