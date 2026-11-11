"""User scripts: an idea in words -> script code -> safety check -> backtest -> NFT-ready listing.

A model (NEAR AI Cloud in the product) drafts the code from the owner's words. This module never
trusts that code: it parses it, allows only a small subset of Python, runs it with no builtins
beyond a short whitelist, and backtests it on history before anything is minted.

A script is one function:

    def target(daily):
        # daily: pandas DataFrame of daily closes (BTC, ETH, SOL, NEAR, XAUT) and "<ASSET>-FUND"
        # funding columns, rows up to and including today. Return weights:
        # {"BTC": 0.5, "USDC": 0.5} or with perps {"BTC-PERP": -0.3, "USDC": 1.0}
        ...

The `code_hash` is sha256 of the exact source, so the NFT is bound to what was reviewed.
"""
from __future__ import annotations

import ast
import hashlib
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .engine import Costs, shadow_returns
from .strategies import CRYPTO, PERP, Strategy, _normalize

ALLOWED_NODES = (
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.Assign, ast.AugAssign, ast.AnnAssign,
    ast.If, ast.For, ast.While, ast.Break, ast.Continue, ast.Pass, ast.Expr, ast.Compare, ast.BoolOp, ast.BinOp,
    ast.UnaryOp, ast.IfExp, ast.Call, ast.keyword, ast.Attribute, ast.Subscript, ast.Slice, ast.Name, ast.Load,
    ast.Store, ast.Constant, ast.Dict, ast.List, ast.Tuple, ast.Set, ast.ListComp, ast.DictComp, ast.GeneratorExp,
    ast.comprehension, ast.And, ast.Or, ast.Not, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In,
    ast.NotIn, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.USub, ast.UAdd,
)
SAFE_BUILTINS = {"abs": abs, "min": min, "max": max, "sum": sum, "len": len, "range": range, "round": round,
                 "float": float, "int": int, "sorted": sorted, "enumerate": enumerate, "zip": zip,
                 "dict": dict, "list": list, "bool": bool}
GLOBALS = {"np": np, "math": math, "CRYPTO": CRYPTO}
MAX_SOURCE = 4_000


class UnsafeScript(ValueError):
    pass


def check_source(src: str) -> ast.Module:
    if len(src) > MAX_SOURCE:
        raise UnsafeScript(f"script longer than {MAX_SOURCE} characters")
    tree = ast.parse(src)
    funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    if len(tree.body) != 1 or not funcs or funcs[0].name != "target" or len(funcs[0].args.args) != 1:
        raise UnsafeScript("a script is exactly one function: def target(daily)")
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED_NODES):
            raise UnsafeScript(f"not allowed: {type(node).__name__} (line {getattr(node, 'lineno', '?')})")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise UnsafeScript(f"private attribute '{node.attr}' is not allowed")
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            raise UnsafeScript(f"name '{node.id}' is not allowed")
        if isinstance(node, ast.Attribute) and node.attr in {"to_csv", "to_pickle", "to_json", "to_parquet",
                                                              "eval", "query", "pipe", "apply", "applymap", "map",
                                                              "load", "save", "tofile", "fromfile", "loadtxt", "savetxt"}:
            raise UnsafeScript(f"method '{node.attr}' is not allowed")
    return tree


@dataclass(frozen=True)
class UserScript(Strategy):
    """A script written by a user (or drafted by AI for them), run in a restricted namespace."""

    name: str = "user"
    source: str = ""

    @property
    def code_hash(self) -> str:
        return hashlib.sha256(self.source.encode()).hexdigest()

    @property
    def uses_perps(self) -> bool:
        return PERP in self.source

    def _fn(self):
        check_source(self.source)
        ns = {"__builtins__": SAFE_BUILTINS, **GLOBALS}
        exec(compile(self.source, f"<{self.name}>", "exec"), ns)  # noqa: S102 - source checked above
        return ns["target"]

    def target(self, daily):
        fn = self.__dict__.get("_cached") or self._fn()
        object.__setattr__(self, "_cached", fn)
        w = fn(daily)
        if not isinstance(w, dict) or not all(isinstance(k, str) for k in w):
            raise UnsafeScript("target must return a dict of weights")
        allowed = set(CRYPTO) | {"USDC", "XAUT"} | {a + PERP for a in CRYPTO}
        bad = [k for k in w if k not in allowed]
        if bad:
            raise UnsafeScript(f"unknown keys {bad}; allowed: {sorted(allowed)}")
        vals = [float(v) for v in w.values()]
        if any(not math.isfinite(v) for v in vals):
            raise UnsafeScript("weights must be finite numbers")
        return _normalize({k: float(v) for k, v in w.items()})


def backtest(script: UserScript, daily: pd.DataFrame, costs: Costs | None = None) -> dict:
    rec = shadow_returns(script, daily, costs or Costs())
    eq = (1 + rec).cumprod()
    sd = rec.std()
    return {
        "id": script.id,
        "code_hash": script.code_hash,
        "uses_perps": script.uses_perps,
        "return": round(float(eq.iloc[-1] - 1), 4),
        "max_drawdown": round(float((1 - eq / eq.cummax()).max()), 4),
        "sharpe": round(float(rec.mean() / sd * np.sqrt(365)), 2) if sd > 0 else 0.0,
        "days": len(rec),
        "next_step": "mint the NFT (free, storage only) -> 8 weeks in the incubator on paper -> eligible for capital",
    }
