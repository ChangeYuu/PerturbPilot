"""把一个 PerturbTrace（ptbench）任务目录转换成 PerturbPilot 任务包。

用法：
  python -m ppsvc.import_ptbench <ptbench 任务目录> <输出的任务包目录> <输出的隐藏数据目录>
  python -m ppsvc.import_ptbench <...三个目录...> --features <STRING Mashup 目录>

--features 指向放着 string_human_genes.txt 和 string_human_mashup_vectors_d800.txt 的目录
（MIT Mashup 公开发布的 STRING 人类基因网络嵌入，https://groups.csail.mit.edu/cb/mashup/）。
按 PerturbTrace 基线的设置处理：去掉第一列剩 799 维，用种子 2022 的高斯矩阵（方差 1/64）
投影到 64 维，每行 L2 归一化。只给在 STRING 里的候选写行；不在的候选没有特征，不补假值。
一个候选都覆盖不到（比如药物任务）时不写特征表，报告里注明。

只搬可以给 agent 看的字段：task_semantics 里的简述、生物系统、扰动方式、读数，和 budget。
数据集身份（data.* 里的来源文件、数据名、原始列名）、implementation_notes、命中名单
都不进 task.json。读数表 scores.csv 和命中名单 hits.txt 写到任务包外的隐藏数据目录，
只有 oracle 那一侧能读。

目标方向按公开的读数描述定：读数写明 decrease/increase 的是有方向的任务（在 score 上取低/高），
其余按 ptbench 的约定"两个方向的效应都算"，在 absolute_effect 上取高。
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from .oracle import Oracle
from .task import Package, read_csv, write_csv, write_json


def action_type(sem: dict[str, Any]) -> str:
    kind = str(sem.get("action_type", "")).lower()
    op = str(sem.get("perturbation_operation", "")).lower()
    if kind == "drug":
        return "drug"
    if kind == "gene":
        if re.search(r"activation|crispra|overexpress", op):
            return "gene_activation"
        if re.search(r"knockout|loss of function|crispri|knockdown|interference", op):
            return "gene_knockout"
    return "other"


def objective_and_fields(sem: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    readout = str(sem.get("readout", "")).strip()
    score = {"name": "score", "description": f"{readout}（带符号的效应分数）"}
    lowered = readout.lower()
    for word, direction in (("decrease", "low"), ("increase", "high")):
        if re.search(rf"\b{word}\b", lowered):
            return (
                {"kind": "hit_discovery", "field": "score", "direction": direction,
                 "description": f"找出命中：{readout}，score 越{'低' if direction == 'low' else '高'}越可能是命中"},
                [score],
            )
    return (
        {"kind": "hit_discovery", "field": "absolute_effect", "direction": "high",
         "description": f"找出命中：{readout} 的效应大，两个方向都算"},
        [score, {"name": "absolute_effect", "description": "score 的绝对值"}],
    )


MASHUP_NAMES = "string_human_genes.txt"
MASHUP_VECTORS = "string_human_mashup_vectors_d800.txt"
MASHUP_DIM = 64
MASHUP_SEED = 2022
MASHUP_FILE = "data/string_mashup64.csv"


def mashup_features(mashup_dir: Path, ids: list[str]) -> dict[str, np.ndarray]:
    """候选 id -> 64 维投影后的 STRING Mashup 向量；只含在 STRING 里的候选。"""
    names = (mashup_dir / MASHUP_NAMES).read_text(encoding="utf-8").split()
    wanted = set(ids)
    keep = [i for i, n in enumerate(names) if n in wanted]
    if not keep:
        return {}
    raw = np.loadtxt(mashup_dir / MASHUP_VECTORS, delimiter="\t", dtype=np.float64)
    if raw.shape[0] != len(names):
        raise ValueError(f"{MASHUP_VECTORS} has {raw.shape[0]} rows but {MASHUP_NAMES} has {len(names)} names")
    raw = raw[:, 1:]
    proj = np.random.RandomState(MASHUP_SEED).normal(0.0, 1.0 / np.sqrt(MASHUP_DIM), size=(raw.shape[1], MASHUP_DIM))
    v = raw[keep] @ proj
    v /= np.maximum(np.linalg.norm(v, axis=1, keepdims=True), np.finfo(np.float64).eps)
    return {names[i]: v[j] for j, i in enumerate(keep)}


def convert(src: Path, out: Path, hidden: Path, features: Path | None = None) -> dict[str, Any]:
    manifest = yaml.safe_load((src / "task_manifest.yaml").read_text(encoding="utf-8"))
    sem = manifest["task_semantics"]
    budget = manifest["budget"]

    header, rows = read_csv(src / "public" / "candidate_actions.csv")
    if header[0] != "action_id":
        raise ValueError("public/candidate_actions.csv must start with action_id")
    ids = [r[0] for r in rows]
    sh, srows = read_csv(src / "hidden" / "oracle_scores.csv")
    if sh[:2] != ["action_id", "score"]:
        raise ValueError("hidden/oracle_scores.csv must have action_id,score")
    scores = {r[0]: float(r[1]) for r in srows}

    objective, fields = objective_and_fields(sem)
    feats = mashup_features(features, ids) if features is not None else {}
    data_cards = []
    if feats:
        data_cards.append({
            "name": "string_mashup",
            "modality": "embedding",
            "index": "candidate",
            "role": "candidate_features",
            "visibility": "public",
            "file": MASHUP_FILE,
        })
        feature_line = (
            f"候选特征：{MASHUP_FILE}，STRING 蛋白互作网络的 Mashup 基因嵌入投影到 {MASHUP_DIM} 维（id + f0..f{MASHUP_DIM - 1}）。"
            f"覆盖 {len(feats)}/{len(ids)} 个候选；其余 {len(ids) - len(feats)} 个不在 STRING 里，没有特征，"
            "决策模块不会推荐它们，但它们仍是候选，可以写理由自己选。"
        )
    else:
        feature_line = "候选只给了标识符，没有其他公开属性。"
    brief_lines = [
        str(sem["agent_safe_brief"]).strip(),
        f"生物系统：{sem.get('biological_system', '未说明')}",
        f"扰动方式：{sem.get('perturbation_operation', '未说明')}",
        f"读数：{sem.get('readout', '未说明')}",
        "读数来自一次已完成筛选的数据表回放：同一个候选每次测都得到同一个值，所以不重复测。",
        feature_line,
    ]
    card = {
        "task_id": f"ptbench-{out.name}",
        "title": str(sem["agent_safe_brief"]).strip().rstrip("."),
        "synthetic": False,
        "brief": "\n".join(brief_lines),
        "action": {"type": action_type(sem), "description": str(sem.get("perturbation_operation", ""))},
        "readout": {"fields": fields, "primary": "score"},
        "objective": objective,
        "budget": {"rounds": int(budget["rounds"]), "batch_size": int(budget["batch_size"]), "allow_repeats": False},
        "feedback_policy": "true_feedback",
        "data_cards": data_cards,
    }
    write_json(out / "task.json", card)
    write_csv(out / "candidates.csv", ["id"], [[c] for c in ids])
    if feats:
        write_csv(
            out / MASHUP_FILE,
            ["id", *[f"f{j}" for j in range(MASHUP_DIM)]],
            [[c, *[f"{x:.6g}" for x in feats[c]]] for c in ids if c in feats],
        )
    names = [f["name"] for f in fields]
    table = []
    for c in ids:
        s = scores.get(c)
        ok = s is not None and math.isfinite(s)
        vals = {"score": s if ok else "", "absolute_effect": abs(s) if ok else ""}
        table.append([c, *[vals[n] for n in names]])
    write_csv(hidden / "scores.csv", ["id", *names], table)

    hits_path = src / "hidden" / "hit_set.npy"
    n_hits = None
    if hits_path.exists():
        hits = [str(h) for h in np.load(hits_path, allow_pickle=True).tolist()]
        (hidden / "hits.txt").write_text("".join(f"{h}\n" for h in hits), encoding="utf-8")
        n_hits = len(hits)

    Oracle(Package.load(out), hidden)  # 转出来的包要能被 oracle 和决策模块读
    notes = []
    if features is not None:
        notes.append(f"STRING Mashup 特征覆盖 {len(feats)}/{len(ids)} 个候选" + ("" if feats else "，没有写特征表") + "。")
    if all(re.fullmatch(r"\d+", c) for c in ids):
        notes.append("候选 id 全是数字编号，任务里没有名称或结构；agent 没法用生物学知识推理这些候选。")
    missing = [c for c in ids if c not in scores]
    if missing:
        notes.append(f"{len(missing)} 个候选在读数表里没有值，测到时读数为空。")
    return {"task_id": card["task_id"], "n_candidates": len(ids), "n_hits": n_hits, "n_featured": len(feats), "objective": objective, "notes": notes}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="ppsvc.import_ptbench")
    p.add_argument("src", help="ptbench 任务目录（含 task_manifest.yaml）")
    p.add_argument("out", help="输出的任务包目录")
    p.add_argument("hidden", help="输出的隐藏数据目录（在任务包外面）")
    p.add_argument("--features", help="STRING Mashup 目录（含 string_human_genes.txt 和 string_human_mashup_vectors_d800.txt）")
    args = p.parse_args(argv)
    out, hidden = Path(args.out), Path(args.hidden)
    for d in (out, hidden):
        if d.exists() and any(d.iterdir()):
            sys.exit(f"{d} is not empty")
    if out.resolve() == hidden.resolve() or out.resolve() in hidden.resolve().parents:
        sys.exit("the hidden directory must be outside the task package")
    info = convert(Path(args.src), out, hidden, Path(args.features) if args.features else None)
    obj = info["objective"]
    print(f"{info['task_id']}: {info['n_candidates']} candidates, {info['n_hits']} hits, "
          f"objective {obj['field']} {obj['direction']} -> {out.resolve()} (hidden {hidden.resolve()})")
    for n in info["notes"]:
        print(f"note: {n}")


if __name__ == "__main__":
    main()
