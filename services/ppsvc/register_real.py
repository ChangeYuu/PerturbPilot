"""把本地真实数据转换成 ppsvc 任务包；生成目录应放在仓库外或被 .gitignore 忽略。"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_SEQUENCE_ROOT = Path("整理后序列优化数据")
DEFAULT_GENE_ROOT = Path("整理后基因扰动数据")
DEFAULT_TASKS_ROOT = Path("real-tasks")
DEFAULT_HIDDEN_ROOT = Path("real-tasks-hidden")

BACKGROUND = {
    "MPRALegNet_HepG2": "HepG2",
    "MPRALegNet_K562": "K562",
    "MPRALegNet_WTC11": "WTC11",
    "Malinois_HepG2": "HepG2",
    "Malinois_K562": "K562",
    "Malinois_SK-N-SH": "SK-N-SH",
    "Ecoli_Wang_2020": "E. coli promoter context",
    "Ecoli_Wang_2023": "E. coli",
    "Yeast_Zelezniak_2022": "S. cerevisiae",
    "Gb1_Arnold_2024": "GB1 protein",
    "TrpB_Arnold_2024": "TrpB protein",
    "folA_Wagner_2023": "folA protein",
    "CreiLOV_Tong_2023": "CreiLOV protein",
}


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_sequence_task(source: Path, tasks_root: Path, hidden_root: Path) -> dict[str, Any]:
    info = json.loads((source / "info.json").read_text(encoding="utf-8"))
    rows: list[tuple[str, str, float]] = []
    with (source / "metadata.csv").open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["sequence", "y"]:
            raise ValueError(f"{source}: metadata.csv must have sequence,y")
        for index, row in enumerate(reader):
            rows.append((f"S{index:06d}", row["sequence"], float(row["y"])))

    task_id = "seq-" + source.name.replace("_", "-")
    task_dir = tasks_root / task_id
    hidden_dir = hidden_root / task_id
    (task_dir / "data").mkdir(parents=True, exist_ok=True)
    hidden_dir.mkdir(parents=True, exist_ok=True)

    with (task_dir / "candidates.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["id", "sequence"])
        writer.writerows((candidate_id, sequence) for candidate_id, sequence, _ in rows)
    with (hidden_dir / "scores.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["id", "y"])
        writer.writerows((candidate_id, y) for candidate_id, _, y in rows)

    with np.load(source / "dataset_onehot.npz", allow_pickle=False) as bundle:
        x = np.asarray(bundle["X"])
    if x.ndim != 2 or len(x) != len(rows):
        raise ValueError(f"{source}: dataset_onehot.npz X shape does not match metadata.csv")
    np.savez_compressed(
        task_dir / "data" / "dataset_onehot.npz",
        X=x.astype(np.float32, copy=False),
        id=np.asarray([candidate_id for candidate_id, _, _ in rows]),
    )

    write_json(task_dir / "task.json", {
        "task_id": task_id,
        "title": f"{source.name} 序列优化",
        "synthetic": False,
        "brief": (
            f"真实序列优化数据集 {source.name}；序列类型 {info['sequence_type']}，长度 "
            f"{info['sequence_length']}，背景 {BACKGROUND.get(source.name, '未注明')}。目标是最大化实验读数 y。"
        ),
        "action": {"type": "other", "description": "选择一条序列进行实验评估"},
        "readout": {"fields": [{"name": "y", "description": "数据集提供的实验读数 y，越大越好"}], "primary": "y"},
        "objective": {"kind": "maximize", "field": "y", "description": "最大化序列实验读数 y"},
        "budget": {"rounds": 10, "batch_size": 8, "allow_repeats": False},
        "feedback_policy": "true_feedback",
        "data_cards": [{
            "name": "sequence_onehot",
            "modality": "embedding",
            "index": "id",
            "role": "candidate_features",
            "visibility": "public",
            "file": "data/dataset_onehot.npz",
        }],
        "source_dataset": source.name,
        "sequence_type": info["sequence_type"],
        "sequence_length": int(info["sequence_length"]),
        "n_samples": len(rows),
    })
    return {"task_id": task_id, "dataset": source.name, "n_candidates": len(rows), "feature_dim": int(x.shape[1])}


def write_gene_task(source: Path, tasks_root: Path, hidden_root: Path) -> dict[str, Any]:
    task_id = "gene-" + source.stem.replace("_achilles", "").replace("_", "-")
    task_dir = tasks_root / task_id
    hidden_dir = hidden_root / task_id
    (task_dir / "data").mkdir(parents=True, exist_ok=True)
    hidden_dir.mkdir(parents=True, exist_ok=True)
    with source.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames or []
        if not fields or fields[0] != "gene" or "y" not in fields:
            raise ValueError(f"{source}: expected gene, ACH-* features, and y")
        feature_names = [name for name in fields[1:] if name != "y"]
        ids: list[str] = []
        scores: list[float] = []
        features: list[list[float]] = []
        for row in reader:
            ids.append(row["gene"])
            scores.append(float(row["y"]))
            features.append([float(row[name]) for name in feature_names])
    with (task_dir / "candidates.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["id", "gene"])
        writer.writerows((gene, gene) for gene in ids)
    with (hidden_dir / "scores.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["id", "y"])
        writer.writerows(zip(ids, scores))
    np.savez_compressed(task_dir / "data" / "achilles_features.npz", X=np.asarray(features, dtype=np.float32), id=np.asarray(ids))
    write_json(task_dir / "task.json", {
        "task_id": task_id,
        "title": f"{source.stem} 基因扰动筛选",
        "synthetic": False,
        "brief": f"真实 Achilles 基因扰动数据 {source.name}。y 是数据文件提供的目标读数；809 个 ACH 细胞系列作为候选特征。",
        "action": {"type": "gene_knockout", "description": "选择一个基因进行扰动评估"},
        "readout": {"fields": [{"name": "y", "description": "数据文件提供的目标读数 y，当前按越大越好注册"}], "primary": "y"},
        "objective": {"kind": "maximize", "field": "y", "description": "最大化数据文件提供的 y"},
        "budget": {"rounds": 10, "batch_size": 8, "allow_repeats": False},
        "feedback_policy": "true_feedback",
        "data_cards": [{"name": "achilles_features", "modality": "embedding", "index": "id", "role": "candidate_features", "visibility": "public", "file": "data/achilles_features.npz"}],
        "source_dataset": source.stem,
        "feature_count": len(feature_names),
    })
    return {"task_id": task_id, "dataset": source.name, "n_candidates": len(ids), "feature_dim": len(feature_names)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sequence-root", type=Path, default=DEFAULT_SEQUENCE_ROOT)
    parser.add_argument("--gene-root", type=Path, default=DEFAULT_GENE_ROOT)
    parser.add_argument("--tasks-root", type=Path, default=DEFAULT_TASKS_ROOT)
    parser.add_argument("--hidden-root", type=Path, default=DEFAULT_HIDDEN_ROOT)
    args = parser.parse_args()
    args.tasks_root.mkdir(parents=True, exist_ok=True)
    args.hidden_root.mkdir(parents=True, exist_ok=True)
    registered = [write_sequence_task(d, args.tasks_root, args.hidden_root) for d in sorted(args.sequence_root.iterdir()) if d.is_dir()]
    for source in sorted(args.gene_root.glob("*.csv")):
        registered.append(write_gene_task(source, args.tasks_root, args.hidden_root))
    write_json(args.tasks_root / "CATALOG.json", registered)
    print(json.dumps(registered, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
