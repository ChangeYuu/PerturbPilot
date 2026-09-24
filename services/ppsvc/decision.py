"""基线决策模块：高斯过程回归 + UCB。

接口（HTTP，JSON）：
  GET  /manifest   能力声明
  POST /propose    {round, k, exclude?}             -> 推荐 + 全候选池 μ/σ + 所用状态版本
  POST /observe    {round, observations:[{id,value}]} -> 回执（接受/拒绝、更新前后版本）
  GET  /snapshot   -> 可恢复的完整状态
  POST /restore    {snapshot}

状态只由本次 run 的观测决定（包括每次观测后按边际似然重选的长度尺度），
所以快照里只需要存观测和版本号，恢复后重算即可。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .jsonhttp import HttpError

DECISION_VERSION = "gp-ucb-baseline/0.1"
LENGTHSCALES = (0.75, 1.5, 3.0, 6.0)


def _rbf(a: np.ndarray, b: np.ndarray, ls: float) -> np.ndarray:
    d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)
    return np.exp(-d2 / (2 * ls * ls))


class GpUcbDecision:
    def __init__(self, candidates: list[dict[str, Any]], noise_sd: float, beta: float = 2.0):
        self.ids = [c["id"] for c in candidates]
        self.index = {cid: i for i, cid in enumerate(self.ids)}
        self.X = np.asarray([c["features"] for c in candidates], dtype=float)
        self.noise_var = float(noise_sd) ** 2
        self.beta = beta
        self.obs: list[tuple[str, float]] = []
        self.version = 0
        self.lengthscale = LENGTHSCALES[1]
        self._mean = 0.0
        self._scale = 1.0

    # ---- 状态 ----

    def _fit(self) -> None:
        if not self.obs:
            self.lengthscale, self._mean, self._scale = LENGTHSCALES[1], 0.0, 1.0
            return
        y = np.array([v for _, v in self.obs])
        self._mean = float(y.mean())
        self._scale = float(y.std()) or 1.0
        best = None
        for ls in LENGTHSCALES:
            ll = self._log_marginal(ls)
            if best is None or ll > best[0]:
                best = (ll, ls)
        self.lengthscale = best[1]

    def _train(self) -> tuple[np.ndarray, np.ndarray]:
        idx = np.array([self.index[c] for c, _ in self.obs])
        y = (np.array([v for _, v in self.obs]) - self._mean) / self._scale
        return idx, y

    def _log_marginal(self, ls: float) -> float:
        idx, y = self._train()
        K = _rbf(self.X[idx], self.X[idx], ls) + (self.noise_var / self._scale**2 + 1e-6) * np.eye(len(idx))
        L = np.linalg.cholesky(K)
        alpha = np.linalg.solve(L.T, np.linalg.solve(L, y))
        return float(-0.5 * y @ alpha - np.log(np.diag(L)).sum() - 0.5 * len(y) * math.log(2 * math.pi))

    def posterior(self) -> tuple[np.ndarray, np.ndarray]:
        if not self.obs:
            n = len(self.ids)
            return np.full(n, self._mean), np.full(n, self._scale)
        idx, y = self._train()
        ls = self.lengthscale
        K = _rbf(self.X[idx], self.X[idx], ls) + (self.noise_var / self._scale**2 + 1e-6) * np.eye(len(idx))
        Ks = _rbf(self.X, self.X[idx], ls)
        L = np.linalg.cholesky(K)
        alpha = np.linalg.solve(L.T, np.linalg.solve(L, y))
        mu = Ks @ alpha
        v = np.linalg.solve(L, Ks.T)
        var = np.clip(1.0 - (v * v).sum(0), 1e-12, None)
        return mu * self._scale + self._mean, np.sqrt(var) * self._scale

    # ---- 接口 ----

    def manifest(self, _body: dict[str, Any]) -> dict[str, Any]:
        return {
            "name": "gp-ucb-baseline",
            "version": DECISION_VERSION,
            "inputs": {"required": ["candidate_features"], "optional": []},
            "acquisition": {"kind": "ucb", "beta": self.beta},
        }

    def propose(self, body: dict[str, Any]) -> dict[str, Any]:
        k = int(body.get("k", 1))
        if k < 1:
            raise HttpError(400, "k must be >= 1")
        exclude = set(body.get("exclude") or [])
        observed = {c for c, _ in self.obs}
        mu, sigma = self.posterior()
        score = mu + self.beta * sigma
        order = [i for i in np.argsort(-score) if self.ids[i] not in exclude and self.ids[i] not in observed]
        recs = [
            {"id": self.ids[i], "mu": float(mu[i]), "sigma": float(sigma[i]), "score": float(score[i]), "rank": r + 1}
            for r, i in enumerate(order[:k])
        ]
        return {
            "decision_version": DECISION_VERSION,
            "round": body.get("round"),
            "state_version": self.version,
            "inputs_used": ["candidate_features"] + (["observations"] if self.obs else []),
            "n_observations": len(self.obs),
            "lengthscale": self.lengthscale,
            "recommendations": recs,
            "pool": [
                {"id": cid, "mu": float(mu[i]), "sigma": float(sigma[i])} for i, cid in enumerate(self.ids)
            ],
        }

    def observe(self, body: dict[str, Any]) -> dict[str, Any]:
        items = body.get("observations")
        if not isinstance(items, list):
            raise HttpError(400, "observations must be a list")
        accepted, rejected = [], []
        for it in items:
            cid, val = (it or {}).get("id"), (it or {}).get("value")
            if cid not in self.index:
                rejected.append({"id": cid, "reason": "unknown_id"})
            elif not isinstance(val, (int, float)) or not math.isfinite(val):
                rejected.append({"id": cid, "reason": "non_finite_value"})
            else:
                accepted.append({"id": cid, "value": float(val)})
        before = self.version
        if accepted:
            self.obs.extend((a["id"], a["value"]) for a in accepted)
            self.version += 1
            self._fit()
        return {
            "decision_version": DECISION_VERSION,
            "round": body.get("round"),
            "accepted": [a["id"] for a in accepted],
            "rejected": rejected,
            "state_version_before": before,
            "state_version_after": self.version,
            "n_observations": len(self.obs),
        }

    def snapshot(self, _body: dict[str, Any]) -> dict[str, Any]:
        return {
            "decision_version": DECISION_VERSION,
            "state_version": self.version,
            "observations": [{"id": c, "value": v} for c, v in self.obs],
        }

    def restore(self, body: dict[str, Any]) -> dict[str, Any]:
        snap = body.get("snapshot") or {}
        if snap.get("decision_version") != DECISION_VERSION:
            raise HttpError(400, "snapshot was made by a different decision module version")
        self.obs = [(o["id"], float(o["value"])) for o in snap.get("observations", [])]
        for c, _ in self.obs:
            if c not in self.index:
                raise HttpError(400, f"unknown candidate id {c!r} in snapshot")
        self.version = int(snap["state_version"])
        self._fit()
        return {"ok": True, "state_version": self.version}

    def routes(self) -> dict[tuple[str, str], Any]:
        return {
            ("GET", "/manifest"): self.manifest,
            ("POST", "/propose"): self.propose,
            ("POST", "/observe"): self.observe,
            ("GET", "/snapshot"): self.snapshot,
            ("POST", "/restore"): self.restore,
            ("GET", "/health"): lambda _b: {"ok": True, "decision_version": DECISION_VERSION},
        }
