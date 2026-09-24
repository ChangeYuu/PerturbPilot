"""任务包：oracle 和决策模块共同读取的一个目录。

  <任务包>/
    task.json        公开的任务卡片
    candidates.csv   id + 公开属性列
    data/            数据卡片的文件（task.json 的 data_cards 里列出）
                     候选特征表（role=candidate_features, modality=embedding）是 id + 数值列的 CSV，
                     可以只覆盖一部分候选：没有行的候选就是没有特征，决策模块不会假装它有

  <隐藏数据目录>/     只有 oracle 读，放在任务包外面（服务用 --hidden 指定）
    scores.csv       id + 各读数字段
    hits.txt         命中名单，可选，运行时不读

任务包整个目录 agent 都可能看到（分析工具会列出它），所以里面只放可以给 agent 看的东西；
任务包里有 hidden/ 目录时直接拒绝加载，免得旧布局的隐藏读数被看到。
没有指定任务包时，用 write_synthetic_package 在两个临时目录里分别生成合成任务包和它的隐藏数据。
"""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

ACTION_TYPES = ("gene_knockout", "gene_activation", "drug", "other")
OBJECTIVE_KINDS = ("maximize", "minimize", "hit_discovery")
MODALITIES = ("embedding", "table", "graph", "text")
ROLES = ("candidate_features", "prior", "knowledge")
VISIBILITIES = ("public", "decision")


class TaskError(ValueError):
    pass


def stable_int(*parts: Any) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()
    return int.from_bytes(h[:8], "little")


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        raise TaskError(f"{path} is empty")
    return rows[0], rows[1:]


def write_csv(path: Path, header: list[str], rows: list[list[Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def check_card(card: dict[str, Any]) -> None:
    """任务卡片的最低要求；不合格就在启动时报错，而不是跑到一半才坏。"""
    for key in ("task_id", "title", "brief", "action", "readout", "objective", "budget"):
        if key not in card:
            raise TaskError(f"task.json is missing {key!r}")
    if card["action"].get("type") not in ACTION_TYPES:
        raise TaskError(f"action.type must be one of {ACTION_TYPES}")
    fields = [f["name"] for f in card["readout"].get("fields", [])]
    if not fields or card["readout"].get("primary") not in fields:
        raise TaskError("readout.fields must be non-empty and readout.primary must be one of them")
    obj = card["objective"]
    if obj.get("kind") not in OBJECTIVE_KINDS:
        raise TaskError(f"objective.kind must be one of {OBJECTIVE_KINDS}")
    if obj.get("field") not in fields:
        raise TaskError("objective.field must be a readout field")
    if obj["kind"] == "hit_discovery" and obj.get("direction") not in ("high", "low"):
        raise TaskError("objective.direction must be high or low for hit_discovery")
    budget = card["budget"]
    if int(budget.get("rounds", 0)) < 1 or int(budget.get("batch_size", 0)) < 1:
        raise TaskError("budget.rounds and budget.batch_size must be >= 1")
    for dc in card.get("data_cards", []):
        if dc.get("modality") not in MODALITIES or dc.get("role") not in ROLES or dc.get("visibility") not in VISIBILITIES:
            raise TaskError(f"bad data card {dc.get('name')!r}")
        rel = Path(dc.get("file", ""))
        if rel.is_absolute() or ".." in rel.parts:
            raise TaskError(f"data card {dc.get('name')!r} must point inside the package")


def target_sign(objective: dict[str, Any]) -> float:
    """把目标字段换成"越大越好"时要乘的符号。"""
    if objective["kind"] == "minimize":
        return -1.0
    if objective["kind"] == "hit_discovery" and objective.get("direction") == "low":
        return -1.0
    return 1.0


@dataclass
class Features:
    """候选特征：rows 是有特征的候选在 ids 里的下标（升序），X 的第 i 行属于 ids[rows[i]]。"""

    rows: np.ndarray
    X: np.ndarray


@dataclass
class Package:
    root: Path
    card: dict[str, Any]
    ids: list[str]

    @classmethod
    def load(cls, root: str | Path) -> "Package":
        root = Path(root).resolve()
        if (root / "hidden").exists():
            raise TaskError(f"{root} contains hidden/; move the hidden data out of the task package and pass it with --hidden")
        card = json.loads((root / "task.json").read_text(encoding="utf-8"))
        check_card(card)
        header, rows = read_csv(root / "candidates.csv")
        if header[0] != "id":
            raise TaskError("candidates.csv must start with an id column")
        ids = [r[0] for r in rows]
        if len(set(ids)) != len(ids):
            raise TaskError("candidates.csv has duplicate ids")
        return cls(root, card, ids)

    def public_card(self) -> dict[str, Any]:
        return {**self.card, "package_dir": str(self.root), "n_candidates": len(self.ids)}

    def features(self, visible: tuple[str, ...] = VISIBILITIES) -> Features | None:
        """把角色为候选特征的嵌入卡片按候选顺序拼起来；有几张卡片时只留每张都有行的候选。没有卡片就返回 None。"""
        tables = []
        known = set(self.ids)
        for dc in self.card.get("data_cards", []):
            if dc["role"] != "candidate_features" or dc["modality"] != "embedding" or dc["visibility"] not in visible:
                continue
            header, rows = read_csv(self.root / dc["file"])
            by_id = {}
            for r in rows:
                if r[0] not in known:
                    raise TaskError(f"data card {dc['name']!r} has a row for {r[0]!r}, which is not a candidate")
                if r[0] in by_id:
                    raise TaskError(f"data card {dc['name']!r} has two rows for {r[0]!r}")
                if len(r) != len(header):
                    raise TaskError(f"data card {dc['name']!r} row {r[0]!r} has {len(r)} columns, expected {len(header)}")
                by_id[r[0]] = [float(x) for x in r[1:]]
            if not by_id:
                raise TaskError(f"data card {dc['name']!r} has no rows")
            tables.append(by_id)
        if not tables:
            return None
        rows = np.array([i for i, c in enumerate(self.ids) if all(c in t for t in tables)], dtype=int)
        if len(rows) == 0:
            raise TaskError("no candidate has a row in every candidate_features card")
        X = np.hstack([np.asarray([t[self.ids[i]] for i in rows], dtype=float).reshape(len(rows), -1) for t in tables])
        return Features(rows, X)


def write_synthetic_package(
    root: str | Path,
    hidden: str | Path,
    seed: int = 0,
    n_candidates: int = 200,
    n_features: int = 8,
    batch_size: int = 6,
    max_rounds: int = 10,
    noise_sd: float = 0.15,
) -> Path:
    """合成扰动筛选任务：候选基因的特征向量和真实效应都由随机种子生成，不是真实生物数据。

    任务包写到 root，隐藏读数写到 hidden（两个目录要分开）。
    同一个 seed 下任务完全确定；oracle 按 (任务, 候选, 第几次测) 给噪声，所以读数与提交顺序无关。
    """
    root, hidden = Path(root), Path(hidden)
    rng = np.random.default_rng(stable_int("task", seed))
    n, d = n_candidates, n_features
    ids = [f"G{i:03d}" for i in range(n)]
    features = rng.standard_normal((n, d))
    # 真实效应：几个高斯"通路"峰 + 一个弱线性项，峰值附近的基因效应最大。
    centers = rng.standard_normal((3, d))
    heights = np.array([1.6, 1.1, 0.8])
    dist2 = ((features[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
    truth = (heights[None, :] * np.exp(-dist2 / (2 * 1.5**2))).sum(-1) + features @ (0.1 * rng.standard_normal(d))

    card = {
        "task_id": f"synthetic-screen-seed{seed}",
        "title": "合成 CRISPR 敲除筛选：找出敲除后目标表型下降最多的基因",
        "synthetic": True,
        "brief": "合成任务：候选基因的特征和效应都是随机生成的，不对应真实基因。每个基因有一个 8 维嵌入；"
        "读数是敲除后目标表型的下降幅度，带测量噪声，同一个基因可以重复测。",
        "action": {"type": "gene_knockout", "description": "敲除一个基因"},
        "readout": {
            "fields": [{"name": "phenotype_reduction", "description": "目标表型的下降幅度，越大表示敲除效果越强"}],
            "primary": "phenotype_reduction",
            "noise_sd": noise_sd,
        },
        "objective": {"kind": "maximize", "field": "phenotype_reduction", "description": "找出表型下降最多的基因"},
        "budget": {"rounds": max_rounds, "batch_size": batch_size, "allow_repeats": True},
        "feedback_policy": "true_feedback",
        "data_cards": [
            {
                "name": "gene_embedding",
                "modality": "embedding",
                "index": "candidate",
                "role": "candidate_features",
                "visibility": "public",
                "file": "data/gene_embedding.csv",
            }
        ],
    }
    write_json(root / "task.json", card)
    write_csv(root / "candidates.csv", ["id"], [[c] for c in ids])
    write_csv(
        root / "data" / "gene_embedding.csv",
        ["id", *[f"f{j}" for j in range(d)]],
        [[c, *[round(float(v), 6) for v in features[i]]] for i, c in enumerate(ids)],
    )
    write_csv(hidden / "scores.csv", ["id", "phenotype_reduction"], [[c, float(truth[i])] for i, c in enumerate(ids)])
    return root
