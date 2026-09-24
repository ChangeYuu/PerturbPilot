"""oracle：按任务包的隐藏读数表回答一批扰动的读数。

读数来自任务包外的隐藏数据目录里的 scores.csv，一个候选一行、每个读数字段一列。
任务卡片的 readout.noise_sd 大于 0 时（合成任务），每次读数加上确定性的测量噪声：
噪声只由 (任务, 候选, 第几次测) 决定，与提交顺序、批次划分无关，从任意一轮分叉重放结果一致。
没有 noise_sd 的任务（例如从已有筛选数据转换来的）每次读数都等于表里的值。
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from .jsonhttp import HttpError
from .task import Package, TaskError, read_csv, stable_int

ORACLE_VERSION = "score-table/0.2"


def _num(text: str) -> float | None:
    try:
        v = float(text)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


class Oracle:
    """实验通道：接收一批候选，当场返回读数。"""

    def __init__(self, package: Package, hidden: str | Path):
        hidden = Path(hidden).resolve()
        if hidden == package.root or package.root in hidden.parents:
            raise TaskError(f"hidden data {hidden} must not be inside the task package {package.root}")
        self.package = package
        self.card = package.card
        self.fields = [f["name"] for f in self.card["readout"]["fields"]]
        self.noise_sd = float(self.card["readout"].get("noise_sd") or 0.0)
        self.batch_size = int(self.card["budget"]["batch_size"])
        self.allow_repeats = bool(self.card["budget"].get("allow_repeats", False))
        self.known = set(package.ids)

        header, rows = read_csv(hidden / "scores.csv")
        missing = [f for f in self.fields if f not in header]
        if header[0] != "id" or missing:
            raise ValueError(f"{hidden / 'scores.csv'} must have an id column and readout fields {self.fields}")
        cols = [header.index(f) for f in self.fields]
        self.table: dict[str, dict[str, float | None]] = {
            r[0]: {f: _num(r[c]) for f, c in zip(self.fields, cols)} for r in rows
        }
        self.replicates: dict[str, int] = {}
        self.log: list[dict[str, Any]] = []

    def measure(self, cid: str, replicate: int) -> dict[str, float | None] | None:
        row = self.table.get(cid)
        if row is None:
            return None
        if self.noise_sd <= 0:
            return dict(row)
        out: dict[str, float | None] = {}
        for f, v in row.items():
            rng = np.random.default_rng(stable_int("noise", self.card["task_id"], f, cid, replicate))
            out[f] = None if v is None else float(v + self.noise_sd * rng.standard_normal())
        return out

    def run(self, body: dict[str, Any]) -> dict[str, Any]:
        batch = body.get("batch")
        round_ = body.get("round")
        if not isinstance(batch, list) or not batch or not all(isinstance(c, str) for c in batch):
            raise HttpError(400, "batch must be a non-empty list of candidate ids")
        if len(batch) > self.batch_size:
            raise HttpError(400, f"batch size {len(batch)} exceeds limit {self.batch_size}")
        for cid in batch:
            if cid not in self.known:
                raise HttpError(400, f"unknown candidate id {cid!r}")
        if not self.allow_repeats:
            again = [c for c in batch if self.replicates.get(c)] or [c for i, c in enumerate(batch) if c in batch[:i]]
            if again:
                raise HttpError(400, f"repeats are not allowed in this task: {again[0]!r}")
        results = []
        for cid in batch:
            rep = self.replicates.get(cid, 0)
            self.replicates[cid] = rep + 1
            results.append({"id": cid, "replicate": rep, "readout": self.measure(cid, rep)})
        entry = {"round": round_, "results": results}
        self.log.append(entry)
        return {"oracle_version": ORACLE_VERSION, **entry}

    def reset(self, body: dict[str, Any]) -> dict[str, Any]:
        """恢复到给定的已测次数（用于分叉重放）；不传则清零。"""
        reps = body.get("replicates") or {}
        self.replicates = {str(k): int(v) for k, v in reps.items()}
        self.log = []
        return {"ok": True}

    def routes(self) -> dict[tuple[str, str], Any]:
        return {
            ("GET", "/task"): lambda _b: self.package.public_card(),
            ("POST", "/run"): self.run,
            ("POST", "/reset"): self.reset,
            ("GET", "/health"): lambda _b: {"ok": True, "oracle_version": ORACLE_VERSION},
        }
