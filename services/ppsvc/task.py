"""任务包：oracle 和决策模块共同读取的一个目录。

  <任务包>/
    task.json        公开的任务卡片
    candidates.csv   id + 公开属性列
    data/            数据卡片的文件（task.json 的 data_cards 里列出）
    hidden/          只有 oracle 读：scores.csv（id + 各读数字段）、hits.txt（命中名单，可选）

task.json 里只放可以给 agent 看的东西；hidden/ 下的文件不出现在卡片里。
没有指定任务包时，用 write_synthetic_package 在临时目录里生成一个合成任务包。
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
        if rel.is_absolute() or ".." in rel.parts or (rel.parts and rel.parts[0] == "hidden"):
            raise TaskError(f"data card {dc.get('name')!r} must point inside the package, outside hidden/")


def target_sign(objective: dict[str, Any]) -> float:
    """把目标字段换成"越大越好"时要乘的符号。"""
    if objective["kind"] == "minimize":
        return -1.0
    if objective["kind"] == "hit_discovery" and objective.get("direction") == "low":
        return -1.0
    return 1.0


@dataclass
class Package:
    root: Path
    card: dict[str, Any]
    ids: list[str]

    @classmethod
    def load(cls, root: str | Path) -> "Package":
        root = Path(root).resolve()
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

    def features(self, visible: tuple[str, ...] = VISIBILITIES) -> np.ndarray | None:
        """把角色为候选特征的嵌入卡片按候选顺序拼成一个矩阵；没有就返回 None。"""
        blocks = []
        for dc in self.card.get("data_cards", []):
            if dc["role"] != "candidate_features" or dc["modality"] != "embedding" or dc["visibility"] not in visible:
                continue
            header, rows = read_csv(self.root / dc["file"])
            by_id = {r[0]: [float(x) for x in r[1:]] for r in rows}
            missing = [c for c in self.ids if c not in by_id]
            if missing:
                raise TaskError(f"data card {dc['name']!r} has no row for {missing[0]!r}")
            blocks.append(np.asarray([by_id[c] for c in self.ids], dtype=float).reshape(len(self.ids), len(header) - 1))
        return np.hstack(blocks) if blocks else None


def write_synthetic_package(
    root: str | Path,
    seed: int = 0,
    n_candidates: int = 200,
    n_features: int = 8,
    batch_size: int = 6,
    max_rounds: int = 10,
    noise_sd: float = 0.15,
) -> Path:
    """合成扰动筛选任务：候选基因的特征向量和真实效应都由随机种子生成，不是真实生物数据。

    同一个 seed 下任务完全确定；oracle 按 (任务, 候选, 第几次测) 给噪声，所以读数与提交顺序无关。
    """
    root = Path(root)
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
    write_csv(root / "hidden" / "scores.csv", ["id", "phenotype_reduction"], [[c, float(truth[i])] for i, c in enumerate(ids)])
    return root
