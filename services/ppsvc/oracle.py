"""合成扰动筛选任务和 oracle。

这是一个**合成**任务，不是真实生物数据：候选基因的特征向量和真实效应都由随机种子生成。
它的作用是让闭环能在本地、可复现地跑起来。

复现性约定：同一个 seed 下，任务本身（候选、真实效应）完全确定；
某个候选第 k 次被测到的读数也完全确定，与提交顺序、批次划分无关。
这样从任意一轮分叉重放时，oracle 给出的结果一致。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .jsonhttp import HttpError

ORACLE_VERSION = "synthetic-screen/0.1"


@dataclass
class TaskConfig:
    seed: int = 0
    n_candidates: int = 200
    n_features: int = 8
    batch_size: int = 6
    max_rounds: int = 10
    noise_sd: float = 0.15


def _stable_int(*parts: Any) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()
    return int.from_bytes(h[:8], "little")


@dataclass
class SyntheticScreen:
    cfg: TaskConfig
    ids: list[str] = field(init=False)
    features: np.ndarray = field(init=False)
    truth: np.ndarray = field(init=False)

    def __post_init__(self) -> None:
        rng = np.random.default_rng(_stable_int("task", self.cfg.seed))
        n, d = self.cfg.n_candidates, self.cfg.n_features
        self.ids = [f"G{i:03d}" for i in range(n)]
        self.features = rng.standard_normal((n, d))
        # 真实效应：几个高斯"通路"峰 + 一个弱线性项，峰值附近的基因效应最大。
        centers = rng.standard_normal((3, d))
        heights = np.array([1.6, 1.1, 0.8])
        dist2 = ((self.features[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        bumps = (heights[None, :] * np.exp(-dist2 / (2 * 1.5**2))).sum(-1)
        linear = self.features @ (0.1 * rng.standard_normal(d))
        self.truth = bumps + linear

    def index_of(self, cid: str) -> int:
        try:
            return self.ids.index(cid)
        except ValueError:
            raise HttpError(400, f"unknown candidate id {cid!r}") from None

    def measure(self, cid: str, replicate: int) -> float:
        i = self.index_of(cid)
        rng = np.random.default_rng(_stable_int("noise", self.cfg.seed, cid, replicate))
        return float(self.truth[i] + self.cfg.noise_sd * rng.standard_normal())

    def card(self) -> dict[str, Any]:
        return {
            "task_id": f"synthetic-screen-seed{self.cfg.seed}",
            "title": "合成 CRISPR 敲除筛选：找出敲除后目标表型下降最多的基因",
            "synthetic": True,
            "objective": {"name": "phenotype_reduction", "direction": "maximize"},
            "batch_size": self.cfg.batch_size,
            "max_rounds": self.cfg.max_rounds,
            "data_cards": [
                {
                    "name": "gene_embedding",
                    "modality": "embedding",
                    "index": "gene",
                    "role": "candidate_features",
                    "shape": [self.cfg.n_candidates, self.cfg.n_features],
                },
                {
                    "name": "phenotype_readout",
                    "modality": "scalar",
                    "index": "gene",
                    "role": "round_readout",
                    "noise_sd": self.cfg.noise_sd,
                },
            ],
            "candidates": [
                {"id": cid, "features": [round(float(v), 6) for v in self.features[i]]}
                for i, cid in enumerate(self.ids)
            ],
        }


class Oracle:
    """实验通道：接收一批候选，当场返回读数。"""

    def __init__(self, cfg: TaskConfig):
        self.task = SyntheticScreen(cfg)
        self.replicates: dict[str, int] = {}
        self.log: list[dict[str, Any]] = []

    def run(self, body: dict[str, Any]) -> dict[str, Any]:
        batch = body.get("batch")
        round_ = body.get("round")
        if not isinstance(batch, list) or not batch or not all(isinstance(c, str) for c in batch):
            raise HttpError(400, "batch must be a non-empty list of candidate ids")
        if len(batch) > self.task.cfg.batch_size:
            raise HttpError(400, f"batch size {len(batch)} exceeds limit {self.task.cfg.batch_size}")
        for cid in batch:
            self.task.index_of(cid)
        results = []
        for cid in batch:
            rep = self.replicates.get(cid, 0)
            self.replicates[cid] = rep + 1
            results.append({"id": cid, "value": self.task.measure(cid, rep), "replicate": rep})
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
            ("GET", "/task"): lambda _b: self.task.card(),
            ("POST", "/run"): self.run,
            ("POST", "/reset"): self.reset,
            ("GET", "/health"): lambda _b: {"ok": True, "oracle_version": ORACLE_VERSION},
        }
