"""基线决策模块：按任务包里有什么输入挑方法。

  gp-ucb    候选有嵌入特征时：高斯过程回归 + UCB
  coverage  没有可用特征时：按任务固定种子的随机顺序覆盖未测候选（只给"测什么"，不假装有模型）
  auto      有嵌入就 gp-ucb，否则 coverage

接口（HTTP，JSON）：
  GET  /manifest   能力声明：方法、需要/可用的输入（[{role, modality}]）
  POST /init       {task, package_dir}                   -> 读任务包，缺必需输入时 400
  POST /propose    {round, k, exclude?}                  -> 推荐（id、rank + 方法自己的数值）+ 全候选池
  POST /observe    {round, observations:[{id,readout}]}  -> 回执（接受/拒绝、更新前后版本）
  GET  /snapshot   -> 可恢复的完整状态
  POST /restore    {snapshot}

目标值 = readout[objective.field]，minimize 和 direction=low 时取负，内部一律"越大越好"。
推荐和池里的 mu 换回原字段的单位，score 是采集函数值（越大越优先）。
状态只由本次 run 的观测决定，快照里只存观测和版本号，恢复后重算。
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np

from .jsonhttp import HttpError
from .task import Package, TaskError, stable_int, target_sign

DECISION_VERSION = "ppsvc-baseline/0.2"
METHODS = ("auto", "gp-ucb", "coverage")
LENGTHSCALES = (0.75, 1.5, 3.0, 6.0)
FEATURES = {"role": "candidate_features", "modality": "embedding"}


def _rbf(a: np.ndarray, b: np.ndarray, ls: float) -> np.ndarray:
    # 展开成 |a|²+|b|²-2ab，候选多、维度高时不建 (n, m, d) 的中间数组。
    d2 = (a * a).sum(1)[:, None] + (b * b).sum(1)[None, :] - 2 * a @ b.T
    return np.exp(-np.clip(d2, 0, None) / (2 * ls * ls))


class GpUcb:
    name = "gp-ucb"

    def __init__(self, X: np.ndarray, noise_sd: float | None, beta: float = 2.0):
        self.X = X
        self.noise_sd = noise_sd
        self.beta = beta
        self.lengthscale = LENGTHSCALES[1]
        self._mean, self._scale = 0.0, 1.0

    def _noise(self) -> float:
        # 已知测量噪声就用它；读数确定的任务给一个小的相对抖动，只为数值稳定。
        rel = (self.noise_sd / self._scale) ** 2 if self.noise_sd else 0.01
        return rel + 1e-6

    def fit(self, idx: np.ndarray, y: np.ndarray) -> None:
        if len(idx) == 0:
            self.lengthscale, self._mean, self._scale = LENGTHSCALES[1], 0.0, 1.0
            return
        self._mean = float(y.mean())
        self._scale = float(y.std()) or 1.0
        self.lengthscale = max(LENGTHSCALES, key=lambda ls: self._log_marginal(idx, y, ls))

    def _chol(self, idx: np.ndarray, ls: float) -> np.ndarray:
        return np.linalg.cholesky(_rbf(self.X[idx], self.X[idx], ls) + self._noise() * np.eye(len(idx)))

    def _log_marginal(self, idx: np.ndarray, y: np.ndarray, ls: float) -> float:
        z = (y - self._mean) / self._scale
        L = self._chol(idx, ls)
        alpha = np.linalg.solve(L.T, np.linalg.solve(L, z))
        return float(-0.5 * z @ alpha - np.log(np.diag(L)).sum() - 0.5 * len(z) * math.log(2 * math.pi))

    def score(self, idx: np.ndarray, y: np.ndarray) -> dict[str, np.ndarray]:
        n = len(self.X)
        if len(idx) == 0:
            mu, sd = np.full(n, self._mean), np.full(n, self._scale)
        else:
            z = (y - self._mean) / self._scale
            L = self._chol(idx, self.lengthscale)
            Ks = _rbf(self.X, self.X[idx], self.lengthscale)
            mu = Ks @ np.linalg.solve(L.T, np.linalg.solve(L, z))
            v = np.linalg.solve(L, Ks.T)
            sd = np.sqrt(np.clip(1.0 - (v * v).sum(0), 1e-12, None))
            mu, sd = mu * self._scale + self._mean, sd * self._scale
        return {"mu": mu, "sigma": sd, "score": mu + self.beta * sd}

    def params(self) -> dict[str, Any]:
        return {"beta": self.beta, "lengthscale": self.lengthscale}


class Coverage:
    name = "coverage"

    def __init__(self, n: int, seed_key: str):
        order = np.random.default_rng(stable_int("coverage", seed_key)).permutation(n)
        self.priority = np.empty(n)
        self.priority[order] = np.arange(n, 0, -1, dtype=float)

    def fit(self, idx: np.ndarray, y: np.ndarray) -> None:
        pass

    def score(self, idx: np.ndarray, y: np.ndarray) -> dict[str, np.ndarray]:
        return {"score": self.priority}

    def params(self) -> dict[str, Any]:
        return {"order": "seeded_random"}


class DecisionService:
    def __init__(self, method: str = "auto"):
        if method not in METHODS:
            raise ValueError(f"method must be one of {METHODS}")
        self.requested = method
        self.package: Package | None = None
        self.model: GpUcb | Coverage | None = None
        self.inputs_used: list[dict[str, str]] = []
        self.obs: list[tuple[str, float]] = []
        self.version = 0

    # ---- 状态 ----

    def _need_init(self) -> Package:
        if self.package is None:
            raise HttpError(409, "decision module is not initialised, call /init first")
        return self.package

    def _train(self) -> tuple[np.ndarray, np.ndarray]:
        idx = np.array([self.index[c] for c, _ in self.obs], dtype=int)
        return idx, np.array([v for _, v in self.obs], dtype=float)

    def _refit(self) -> None:
        assert self.model is not None
        self.model.fit(*self._train())

    # ---- 接口 ----

    def manifest(self, _body: dict[str, Any]) -> dict[str, Any]:
        required = [FEATURES] if self.requested == "gp-ucb" else []
        optional = [FEATURES] if self.requested == "auto" else []
        return {
            "name": "ppsvc-baseline",
            "version": DECISION_VERSION,
            "method": self.requested if self.model is None else self.model.name,
            "methods": {"gp-ucb": "嵌入特征上的高斯过程 + UCB", "coverage": "按固定种子的随机顺序覆盖未测候选"},
            "inputs": {"required": required, "optional": optional},
        }

    def init(self, body: dict[str, Any]) -> dict[str, Any]:
        pkg_dir = body.get("package_dir")
        if not isinstance(pkg_dir, str) or not pkg_dir:
            raise HttpError(400, "package_dir is required")
        try:
            pkg = Package.load(Path(pkg_dir))
            X = pkg.features()
        except (OSError, TaskError, ValueError) as e:
            raise HttpError(400, f"cannot load task package: {e}") from None
        task = body.get("task") or {}
        if task.get("task_id") not in (None, pkg.card["task_id"]):
            raise HttpError(400, "task.task_id does not match the package")
        if self.requested == "gp-ucb" and X is None:
            raise HttpError(400, "missing required input candidate_features/embedding")
        self.package = pkg
        self.ids = pkg.ids
        self.index = {cid: i for i, cid in enumerate(self.ids)}
        self.objective = pkg.card["objective"]
        self.sign = target_sign(self.objective)
        if X is not None and self.requested != "coverage":
            noise = pkg.card["readout"].get("noise_sd")
            self.model = GpUcb(X, float(noise) if noise else None)
            self.inputs_used = [FEATURES]
        else:
            self.model = Coverage(len(self.ids), pkg.card["task_id"])
            self.inputs_used = []
        self.obs, self.version = [], 0
        self._refit()
        return {"ok": True, "decision_version": DECISION_VERSION, "method": self.model.name, "inputs_used": self.inputs_used}

    def _views(self, cols: dict[str, np.ndarray], i: int) -> dict[str, float]:
        out = {}
        for k, v in cols.items():
            # mu 换回原字段的单位；sigma 和 score 不带方向。
            out[k] = float(v[i] * self.sign) if k == "mu" else float(v[i])
        return out

    def propose(self, body: dict[str, Any]) -> dict[str, Any]:
        self._need_init()
        k = int(body.get("k", 1))
        if k < 1:
            raise HttpError(400, "k must be >= 1")
        exclude = set(body.get("exclude") or [])
        observed = {c for c, _ in self.obs}
        cols = self.model.score(*self._train())
        order = [i for i in np.argsort(-cols["score"], kind="stable") if self.ids[i] not in exclude and self.ids[i] not in observed]
        recs = [{"id": self.ids[i], "rank": r + 1, **self._views(cols, i)} for r, i in enumerate(order[:k])]
        return {
            "decision_version": DECISION_VERSION,
            "method": self.model.name,
            "round": body.get("round"),
            "state_version": self.version,
            "inputs_used": [f"{x['role']}/{x['modality']}" for x in self.inputs_used] + (["observations"] if self.obs else []),
            "n_observations": len(self.obs),
            "params": self.model.params(),
            "recommendations": recs,
            "pool": [{"id": cid, "measured": cid in observed, **self._views(cols, i)} for i, cid in enumerate(self.ids)],
        }

    def observe(self, body: dict[str, Any]) -> dict[str, Any]:
        self._need_init()
        items = body.get("observations")
        if not isinstance(items, list):
            raise HttpError(400, "observations must be a list")
        field = self.objective["field"]
        accepted, rejected = [], []
        for it in items:
            it = it or {}
            cid, readout = it.get("id"), it.get("readout")
            val = readout.get(field) if isinstance(readout, dict) else None
            if cid not in self.index:
                rejected.append({"id": cid, "reason": "unknown_id"})
            elif not isinstance(readout, dict):
                rejected.append({"id": cid, "reason": "missing_readout"})
            elif not isinstance(val, (int, float)) or isinstance(val, bool) or not math.isfinite(val):
                rejected.append({"id": cid, "reason": "non_finite_value"})
            else:
                accepted.append((cid, float(val) * self.sign))
        before = self.version
        if accepted:
            self.obs.extend(accepted)
            self.version += 1
            self._refit()
        return {
            "decision_version": DECISION_VERSION,
            "round": body.get("round"),
            "accepted": [c for c, _ in accepted],
            "rejected": rejected,
            "state_version_before": before,
            "state_version_after": self.version,
            "n_observations": len(self.obs),
        }

    def snapshot(self, _body: dict[str, Any]) -> dict[str, Any]:
        self._need_init()
        return {
            "decision_version": DECISION_VERSION,
            "method": self.model.name,
            "state_version": self.version,
            "observations": [{"id": c, "target": v} for c, v in self.obs],
        }

    def restore(self, body: dict[str, Any]) -> dict[str, Any]:
        self._need_init()
        snap = body.get("snapshot") or {}
        if snap.get("decision_version") != DECISION_VERSION or snap.get("method") != self.model.name:
            raise HttpError(400, "snapshot was made by a different decision module version or method")
        obs = [(o["id"], float(o["target"])) for o in snap.get("observations", [])]
        for c, _ in obs:
            if c not in self.index:
                raise HttpError(400, f"unknown candidate id {c!r} in snapshot")
        self.obs = obs
        self.version = int(snap["state_version"])
        self._refit()
        return {"ok": True, "state_version": self.version}

    def routes(self) -> dict[tuple[str, str], Any]:
        return {
            ("GET", "/manifest"): self.manifest,
            ("POST", "/init"): self.init,
            ("POST", "/propose"): self.propose,
            ("POST", "/observe"): self.observe,
            ("GET", "/snapshot"): self.snapshot,
            ("POST", "/restore"): self.restore,
            ("GET", "/health"): lambda _b: {"ok": True, "decision_version": DECISION_VERSION},
        }
