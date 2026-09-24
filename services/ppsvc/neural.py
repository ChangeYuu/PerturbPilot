"""CoreSet 和 TopUncertain：每轮从头训练一个单隐层 MC-dropout MLP，再按它挑候选。

方法和超参数照 PerturbTrace 论文附录里冻结的 GeneDisco 基线设置重写（不是 genedisco 包本身）：
  隐层 32，ReLU，dropout（CoreSet 0.1，TopUncertain 0.5），Adam 学习率 0.01，
  最多 100 个 epoch，留 20% 做验证，验证损失 10 个 epoch 不降就停，取验证最好的权重。
  CoreSet      在隐层表示上做贪心 farthest-first：离已测候选（和本批先选的）最远的先选
  TopUncertain dropout 打开采样 100 次，预测标准差最大的先选
有特征的已测候选不到 2 个时还没法训练，两种方法都退回在原始特征上做 farthest-first，params 里写明。
每次训练的随机种子由 (任务, 状态版本) 决定，同样的观测得到同样的推荐，快照恢复后也一样。
"""

from __future__ import annotations

from typing import Any

import numpy as np
import torch

HIDDEN = 32
LR = 0.01
MAX_EPOCHS = 100
VAL_FRACTION = 0.2
PATIENCE = 10
MC_SAMPLES = 100
MIN_TRAIN = 2


class _Net(torch.nn.Module):
    def __init__(self, d: int, dropout: float):
        super().__init__()
        self.inp = torch.nn.Linear(d, HIDDEN)
        self.drop = torch.nn.Dropout(dropout)
        self.out = torch.nn.Linear(HIDDEN, 1)

    def hidden(self, x: torch.Tensor) -> torch.Tensor:
        return torch.relu(self.inp(x))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.out(self.drop(self.hidden(x))).squeeze(-1)


def farthest_first(E: np.ndarray, centers: np.ndarray, blocked: np.ndarray, k: int) -> dict[str, np.ndarray]:
    """贪心 farthest-first，选 k 个。centers 是已测点（作中心、不选），blocked 的点不选。

    返回两列：distance —— 选中的点是它被选时到最近中心的距离，其余是选完后到最近中心的距离；
    score —— 选中的点按选择顺序排在最前（越先选越大），其余按 distance。没有中心时先选离重心最近的点。
    """
    n = len(E)
    sq = (E * E).sum(1)

    def dist_to(j: int) -> np.ndarray:
        return np.sqrt(np.clip(sq - 2 * E @ E[j] + sq[j], 0, None))

    d = np.full(n, np.inf)
    for j in centers:
        d = np.minimum(d, dist_to(int(j)))
    open_ = ~blocked
    open_[centers] = False
    picks, pick_d = [], []
    for _ in range(min(k, int(open_.sum()))):
        if np.isinf(d).all():
            c = E.mean(0)
            j = int(np.argmin(np.where(open_, ((E - c) ** 2).sum(1), np.inf)))
            pick_d.append(float(np.sqrt(((E[j] - c) ** 2).sum())))
        else:
            j = int(np.argmax(np.where(open_, d, -np.inf)))
            pick_d.append(float(d[j]))
        picks.append(j)
        open_[j] = False
        d = np.minimum(d, dist_to(j))
    distance = np.where(np.isfinite(d), d, 0.0)
    top = float(distance.max()) if n else 0.0
    score = distance.copy()
    for s_, (j, dj) in enumerate(zip(picks, pick_d)):
        distance[j] = dj
        score[j] = top + len(picks) - s_
    return {"distance": distance, "score": score}


class _MlpMethod:
    dropout: float
    name: str

    def __init__(self, X: np.ndarray, seed_key: str):
        self.X = X.astype(np.float32)
        self.seed_key = seed_key
        self.net: _Net | None = None
        self._mean, self._scale = 0.0, 1.0
        self.fit_info: dict[str, Any] = {}

    def _seed(self, version: int, what: str) -> int:
        from .task import stable_int

        return stable_int(self.name, what, self.seed_key, version) % (2**31)

    def fit(self, idx: np.ndarray, y: np.ndarray, version: int = 0) -> None:
        self.net, self.fit_info = None, {"n_train": int(len(idx))}
        if len(idx) < MIN_TRAIN:
            return
        self._mean = float(y.mean())
        self._scale = float(y.std()) or 1.0
        z = torch.tensor((y - self._mean) / self._scale, dtype=torch.float32)
        x = torch.from_numpy(self.X[idx])
        with torch.random.fork_rng():
            torch.manual_seed(self._seed(version, "fit"))
            perm = torch.randperm(len(idx))
            n_val = int(round(VAL_FRACTION * len(idx))) if len(idx) >= 5 else 0
            val, tr = perm[:n_val], perm[n_val:]
            net = _Net(self.X.shape[1], self.dropout)
            opt = torch.optim.Adam(net.parameters(), lr=LR)
            best, best_state, wait, epochs = float("inf"), None, 0, 0
            for epochs in range(1, MAX_EPOCHS + 1):
                net.train()
                opt.zero_grad()
                loss = torch.mean((net(x[tr]) - z[tr]) ** 2)
                loss.backward()
                opt.step()
                if n_val == 0:
                    continue
                net.eval()
                with torch.no_grad():
                    v = float(torch.mean((net(x[val]) - z[val]) ** 2))
                if v < best:
                    best, best_state, wait = v, {k: t.clone() for k, t in net.state_dict().items()}, 0
                else:
                    wait += 1
                    if wait >= PATIENCE:
                        break
            if best_state is not None:
                net.load_state_dict(best_state)
        self.net = net
        self.fit_info = {"n_train": int(len(tr)), "n_val": n_val, "epochs": epochs}

    def params(self) -> dict[str, Any]:
        space = "hidden_layer" if self.net is not None else "raw_features"
        return {"hidden": HIDDEN, "dropout": self.dropout, "lr": LR, "space": space, **self.fit_info}


class CoreSet(_MlpMethod):
    name = "coreset"
    dropout = 0.1

    def score(self, idx: np.ndarray, y: np.ndarray, blocked: np.ndarray, k: int) -> dict[str, np.ndarray]:
        if self.net is None:
            E = self.X
        else:
            self.net.eval()
            with torch.no_grad():
                E = self.net.hidden(torch.from_numpy(self.X)).numpy()
        return farthest_first(E.astype(float), np.asarray(idx, dtype=int), blocked.copy(), k)


class TopUncertain(_MlpMethod):
    name = "top-uncertain"
    dropout = 0.5

    def __init__(self, X: np.ndarray, seed_key: str):
        super().__init__(X, seed_key)
        self._version = 0

    def fit(self, idx: np.ndarray, y: np.ndarray, version: int = 0) -> None:
        self._version = version
        super().fit(idx, y, version)

    def score(self, idx: np.ndarray, y: np.ndarray, blocked: np.ndarray, k: int) -> dict[str, np.ndarray]:
        if self.net is None:
            return farthest_first(self.X.astype(float), np.asarray(idx, dtype=int), blocked.copy(), k)
        x = torch.from_numpy(self.X)
        self.net.train()  # dropout 打开做 MC 采样
        with torch.random.fork_rng(), torch.no_grad():
            torch.manual_seed(self._seed(self._version, "mc"))
            samples = torch.stack([self.net(x) for _ in range(MC_SAMPLES)]).numpy().astype(float)
        mu = samples.mean(0) * self._scale + self._mean
        sd = samples.std(0) * self._scale
        return {"mu": mu, "sigma": sd, "score": sd}

    def params(self) -> dict[str, Any]:
        return {**super().params(), "mc_samples": MC_SAMPLES}
