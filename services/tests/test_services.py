import json
import threading
import urllib.request

import numpy as np
import pytest

from ppsvc.decision import DecisionService
from ppsvc.import_ptbench import convert
from ppsvc.jsonhttp import HttpError, make_server
from ppsvc.oracle import Oracle
from ppsvc.task import Package, TaskError, write_json, write_synthetic_package


def make(tmp_path, seed=0, method="auto", **kw):
    root = write_synthetic_package(tmp_path / f"syn{seed}", tmp_path / f"syn{seed}-hidden", seed=seed, **kw)
    pkg = Package.load(root)
    d = DecisionService(method)
    d.init({"task": pkg.public_card(), "package_dir": str(root)})
    return Oracle(pkg, tmp_path / f"syn{seed}-hidden"), pkg, d


def ro(x):
    return {"id": x["id"], "readout": x["readout"]}


def truth_of(oracle, cid):
    return oracle.table[cid]["phenotype_reduction"]


def hidden_of(root):
    return root.parent / f"{root.name}-hidden"


def small_package(root, *, objective, fields=("score",), allow_repeats=False, ids=("A", "B", "C", "D"), values=None):
    values = values or {c: float(i) for i, c in enumerate(ids)}
    write_json(root / "task.json", {
        "task_id": "t-small", "title": "小任务", "synthetic": False, "brief": "测试用",
        "action": {"type": "drug", "description": "加药"},
        "readout": {"fields": [{"name": f, "description": f} for f in fields], "primary": fields[0]},
        "objective": objective,
        "budget": {"rounds": 2, "batch_size": 2, "allow_repeats": allow_repeats},
        "feedback_policy": "true_feedback", "data_cards": [],
    })
    (root / "candidates.csv").write_text("id\n" + "".join(f"{c}\n" for c in ids), encoding="utf-8")
    rows = "".join(f"{c},{','.join(str(abs(values[c]) if f == 'absolute_effect' else values[c]) for f in fields)}\n" for c in ids)
    hidden_of(root).mkdir(parents=True, exist_ok=True)
    (hidden_of(root) / "scores.csv").write_text(f"id,{','.join(fields)}\n{rows}", encoding="utf-8")
    return root


# ---- 任务包 ----


def test_synthetic_package_is_deterministic_per_seed(tmp_path):
    a, b, c = (Package.load(write_synthetic_package(tmp_path / n, tmp_path / f"{n}-hidden", seed=s)) for n, s in (("a", 1), ("b", 1), ("c", 2)))
    assert np.array_equal(a.features(), b.features())
    assert not np.array_equal(a.features(), c.features())
    assert (tmp_path / "a-hidden" / "scores.csv").read_text(encoding="utf-8") == (tmp_path / "b-hidden" / "scores.csv").read_text(encoding="utf-8")
    assert not (tmp_path / "a" / "hidden").exists()


def test_public_card_has_no_hidden_data(tmp_path):
    _, pkg, _ = make(tmp_path)
    card = pkg.public_card()
    assert card["n_candidates"] == 200 and card["package_dir"] == str(pkg.root)
    assert "candidates" not in card
    assert "scores" not in json.dumps(card)
    # 任务包目录里没有任何隐藏读数
    files = sorted(str(x.relative_to(pkg.root)).replace("\\", "/") for x in pkg.root.rglob("*") if x.is_file())
    assert files == ["candidates.csv", "data/gene_embedding.csv", "task.json"]


def test_hidden_data_must_live_outside_the_package(tmp_path):
    root = small_package(tmp_path / "p", objective={"kind": "maximize", "field": "score"})
    pkg = Package.load(root)
    for inside in (root, root / "secret"):
        with pytest.raises(TaskError, match="must not be inside"):
            Oracle(pkg, inside)
    # 旧布局：任务包里还有 hidden/，直接拒绝加载
    (root / "hidden").mkdir()
    with pytest.raises(TaskError, match="contains hidden"):
        Package.load(root)


def test_bad_cards_are_rejected(tmp_path):
    root = small_package(tmp_path / "p", objective={"kind": "hit_discovery", "field": "score"})
    with pytest.raises(TaskError, match="direction"):
        Package.load(root)
    root = small_package(tmp_path / "q", objective={"kind": "maximize", "field": "nope"})
    with pytest.raises(TaskError, match="readout field"):
        Package.load(root)
    root = small_package(tmp_path / "r", objective={"kind": "maximize", "field": "score"})
    card = json.loads((root / "task.json").read_text(encoding="utf-8"))
    card["data_cards"] = [{"name": "x", "modality": "table", "index": "candidate", "role": "prior", "visibility": "public", "file": "../p-hidden/scores.csv"}]
    write_json(root / "task.json", card)
    with pytest.raises(TaskError, match="inside the package"):
        Package.load(root)


# ---- oracle ----


def test_readout_independent_of_submission_order(tmp_path):
    o1, _, _ = make(tmp_path)
    o2 = Oracle(Package.load(tmp_path / "syn0"), tmp_path / "syn0-hidden")
    r1 = o1.run({"round": 1, "batch": ["G001", "G002"]})["results"]
    r2 = o2.run({"round": 1, "batch": ["G002", "G001"]})["results"]
    assert {r["id"]: r["readout"] for r in r1} == {r["id"]: r["readout"] for r in r2}


def test_replicates_differ_and_reset_restores(tmp_path):
    o, _, _ = make(tmp_path)
    v0 = o.run({"batch": ["G005"]})["results"][0]["readout"]
    v1 = o.run({"batch": ["G005"]})["results"][0]["readout"]
    assert v0 != v1
    o.reset({"replicates": {"G005": 1}})
    assert o.run({"batch": ["G005"]})["results"][0]["readout"] == v1


def test_oracle_rejects_bad_batches(tmp_path):
    o, _, _ = make(tmp_path)
    for batch in ([], ["NOPE"], [f"G{i:03d}" for i in range(7)]):
        with pytest.raises(HttpError):
            o.run({"batch": batch})


def test_table_task_is_exact_and_refuses_repeats(tmp_path):
    root = small_package(tmp_path / "p", objective={"kind": "hit_discovery", "field": "absolute_effect", "direction": "high"},
                         fields=("score", "absolute_effect"), values={"A": -2.5, "B": 1.0, "C": 0.1, "D": -0.2})
    o = Oracle(Package.load(root), hidden_of(root))
    res = o.run({"round": 1, "batch": ["A", "B"]})["results"]
    assert res == [{"id": "A", "replicate": 0, "readout": {"score": -2.5, "absolute_effect": 2.5}},
                   {"id": "B", "replicate": 0, "readout": {"score": 1.0, "absolute_effect": 1.0}}]
    for batch in (["A"], ["C", "C"]):
        with pytest.raises(HttpError, match="repeats"):
            o.run({"batch": batch})


def test_missing_score_gives_empty_readout(tmp_path):
    root = small_package(tmp_path / "p", objective={"kind": "maximize", "field": "score"})
    (hidden_of(root) / "scores.csv").write_text("id,score\nA,1\nB,\nC,nan\n", encoding="utf-8")
    o = Oracle(Package.load(root), hidden_of(root))
    res = {r["id"]: r["readout"] for r in o.run({"batch": ["B", "D"]})["results"]}
    assert res == {"B": {"score": None}, "D": None}
    assert o.run({"batch": ["C"]})["results"][0]["readout"] == {"score": None}


# ---- 决策模块 ----


def test_decision_needs_init_and_required_inputs(tmp_path):
    d = DecisionService("gp-ucb")
    with pytest.raises(HttpError) as e:
        d.propose({"k": 1})
    assert e.value.status == 409
    assert d.manifest({})["inputs"]["required"] == [{"role": "candidate_features", "modality": "embedding"}]
    root = small_package(tmp_path / "p", objective={"kind": "maximize", "field": "score"})
    with pytest.raises(HttpError, match="candidate_features"):
        d.init({"package_dir": str(root)})
    with pytest.raises(HttpError, match="cannot load"):
        DecisionService().init({"package_dir": str(tmp_path / "nope")})


def test_auto_picks_method_by_inputs(tmp_path):
    _, _, d = make(tmp_path)
    assert d.model.name == "gp-ucb"
    p = d.propose({"round": 1, "k": 3})
    assert p["method"] == "gp-ucb" and p["inputs_used"] == ["candidate_features/embedding"]
    assert set(p["recommendations"][0]) == {"id", "rank", "mu", "sigma", "score"}

    root = small_package(tmp_path / "p", objective={"kind": "maximize", "field": "score"})
    c = DecisionService()
    assert c.init({"package_dir": str(root)})["method"] == "coverage"
    p = c.propose({"round": 1, "k": 4})
    assert p["inputs_used"] == [] and sorted(r["id"] for r in p["recommendations"]) == ["A", "B", "C", "D"]
    assert set(p["recommendations"][0]) == {"id", "rank", "score"}
    # 同一个任务的覆盖顺序固定
    c2 = DecisionService("coverage")
    c2.init({"package_dir": str(root)})
    assert c2.propose({"k": 4})["recommendations"] == p["recommendations"]


def test_observe_receipt_and_versioning(tmp_path):
    _, _, d = make(tmp_path)
    p0 = d.propose({"round": 1, "k": 3})
    assert p0["state_version"] == 0 and len(p0["recommendations"]) == 3
    receipt = d.observe({"round": 1, "observations": [
        {"id": "G001", "readout": {"phenotype_reduction": 1.0}},
        {"id": "BAD", "readout": {"phenotype_reduction": 1.0}},
        {"id": "G002", "readout": {"phenotype_reduction": float("nan")}},
        {"id": "G003", "readout": None},
    ]})
    assert receipt["accepted"] == ["G001"]
    assert sorted(r["reason"] for r in receipt["rejected"]) == ["missing_readout", "non_finite_value", "unknown_id"]
    assert (receipt["state_version_before"], receipt["state_version_after"]) == (0, 1)
    p1 = d.propose({"round": 2, "k": 3})
    assert p1["state_version"] == 1
    assert "G001" not in [r["id"] for r in p1["recommendations"]]
    assert next(x for x in p1["pool"] if x["id"] == "G001")["measured"] is True


def test_observation_changes_posterior(tmp_path):
    _, _, d = make(tmp_path)
    before = {x["id"]: x for x in d.propose({"k": 1})["pool"]}
    d.observe({"observations": [{"id": "G010", "readout": {"phenotype_reduction": 2.0}}]})
    after = {x["id"]: x for x in d.propose({"k": 1})["pool"]}
    assert after["G010"]["sigma"] < before["G010"]["sigma"]
    assert abs(after["G010"]["mu"] - 2.0) < abs(before["G010"]["mu"] - 2.0)


def test_minimize_direction_flips_target(tmp_path):
    """direction=low：观测到的低值应当被当成好结果，mu 仍按原字段单位报告。"""
    X = np.array([[0.0], [0.1], [5.0], [5.1]])
    root = small_package(tmp_path / "p", objective={"kind": "hit_discovery", "field": "score", "direction": "low"})
    (root / "data").mkdir()
    (root / "data" / "emb.csv").write_text("id,f0\n" + "".join(f"{c},{X[i, 0]}\n" for i, c in enumerate("ABCD")), encoding="utf-8")
    card = json.loads((root / "task.json").read_text(encoding="utf-8"))
    card["data_cards"] = [{"name": "emb", "modality": "embedding", "index": "candidate", "role": "candidate_features", "visibility": "public", "file": "data/emb.csv"}]
    write_json(root / "task.json", card)
    d = DecisionService()
    d.init({"package_dir": str(root)})
    d.observe({"observations": [{"id": "A", "readout": {"score": -3.0}}, {"id": "C", "readout": {"score": 3.0}}]})
    p = d.propose({"k": 2})
    assert [r["id"] for r in p["recommendations"]][0] == "B"  # 挨着低值的 A
    assert next(x for x in p["pool"] if x["id"] == "A")["mu"] < 0


def test_snapshot_restore_roundtrip(tmp_path):
    _, _, d = make(tmp_path)
    d.observe({"observations": [{"id": "G003", "readout": {"phenotype_reduction": 0.5}}, {"id": "G004", "readout": {"phenotype_reduction": 1.5}}]})
    snap = d.snapshot({})
    before = d.propose({"k": 5})
    d2 = DecisionService()
    d2.init({"package_dir": str(tmp_path / "syn0")})
    d2.restore({"snapshot": snap})
    after = d2.propose({"k": 5})
    assert before["recommendations"] == after["recommendations"]
    assert after["state_version"] == snap["state_version"]
    c = DecisionService("coverage")
    c.init({"package_dir": str(tmp_path / "syn0")})
    with pytest.raises(HttpError, match="method"):
        c.restore({"snapshot": snap})


def test_closed_loop_beats_random_on_average(tmp_path):
    """GP-UCB 的闭环在合成任务上应当比随机选择找到更好的候选（多个种子平均）。"""
    gains = []
    for seed in range(5):
        oracle, pkg, d = make(tmp_path, seed)
        truth = np.array([truth_of(oracle, c) for c in pkg.ids])
        for r in range(1, 9):
            batch = [x["id"] for x in d.propose({"round": r, "k": 6})["recommendations"]]
            res = oracle.run({"round": r, "batch": batch})["results"]
            d.observe({"round": r, "observations": [ro(x) for x in res]})
        best_found = max(truth_of(oracle, c) for c, _ in d.obs)
        rng = np.random.default_rng(seed)
        random_best = max(truth[rng.choice(len(truth), 48, replace=False)])
        gains.append(best_found - random_best)
    assert np.mean(gains) > 0


# ---- ptbench 转换 ----


def ptbench_task(root, readout, action_type="gene", operation="gene knockout", ids=("G1", "G2", "G3", "G4")):
    (root / "public").mkdir(parents=True)
    (root / "hidden").mkdir()
    (root / "task_manifest.yaml").write_text(
        "task_id: T_secret_dataset_v0\n"
        "data:\n  data_name: SECRET_DATA\n  source_files:\n    original_candidate_table: secret/ground_truth.csv\n"
        "task_semantics:\n"
        "  agent_safe_brief: Select perturbations that change the readout.\n"
        "  biological_system: some cells\n"
        f"  perturbation_operation: {operation}\n"
        f"  action_type: {action_type}\n"
        f"  readout: {readout}\n"
        "budget:\n  rounds: 3\n  batch_size: 2\n"
        "implementation_notes: SECRET_NOTE\n",
        encoding="utf-8",
    )
    (root / "public" / "candidate_actions.csv").write_text("action_id\n" + "".join(f"{c}\n" for c in ids), encoding="utf-8")
    (root / "hidden" / "oracle_scores.csv").write_text(
        "action_id,score\n" + "".join(f"{c},{v}\n" for c, v in zip(ids, (-2.0, 0.5, 1.5, -0.1))), encoding="utf-8")
    np.save(root / "hidden" / "hit_set.npy", np.array([ids[0], ids[2]], dtype=object), allow_pickle=True)
    return root


def test_ptbench_absolute_task_converts(tmp_path):
    src = ptbench_task(tmp_path / "src", "normalized cytokine production")
    info = convert(src, tmp_path / "il2", tmp_path / "il2-hidden")
    pkg = Package.load(tmp_path / "il2")
    card = pkg.card
    assert card["task_id"] == "ptbench-il2" and card["synthetic"] is False
    assert card["action"]["type"] == "gene_knockout"
    assert card["objective"] == {**card["objective"], "kind": "hit_discovery", "field": "absolute_effect", "direction": "high"}
    assert [f["name"] for f in card["readout"]["fields"]] == ["score", "absolute_effect"]
    assert card["budget"] == {"rounds": 3, "batch_size": 2, "allow_repeats": False}
    text = (tmp_path / "il2" / "task.json").read_text(encoding="utf-8")
    assert "SECRET" not in text and "secret" not in text and "T_secret" not in text
    assert (tmp_path / "il2-hidden" / "hits.txt").read_text(encoding="utf-8") == "G1\nG3\n"
    assert sorted(x.name for x in (tmp_path / "il2").iterdir()) == ["candidates.csv", "task.json"]
    assert info["n_hits"] == 2 and info["notes"] == []
    res = Oracle(pkg, tmp_path / "il2-hidden").run({"batch": ["G1"]})["results"][0]["readout"]
    assert res == {"score": -2.0, "absolute_effect": 2.0}


def test_ptbench_directional_and_drug_tasks(tmp_path):
    src = ptbench_task(tmp_path / "src", "protein abundance decrease")
    convert(src, tmp_path / "down", tmp_path / "down-hidden")
    obj = Package.load(tmp_path / "down").card["objective"]
    assert (obj["field"], obj["direction"]) == ("score", "low")

    src = ptbench_task(tmp_path / "src2", "sensitivity z-score", action_type="drug", operation="small-molecule treatment", ids=("101", "102", "103", "104"))
    info = convert(src, tmp_path / "drug", tmp_path / "drug-hidden")
    assert Package.load(tmp_path / "drug").card["action"]["type"] == "drug"
    assert any("数字编号" in n for n in info["notes"])


# ---- HTTP ----


def _post(url, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def test_http_roundtrip(tmp_path):
    root = write_synthetic_package(tmp_path / "syn", tmp_path / "syn-hidden", seed=0)
    oracle, d = Oracle(Package.load(root), tmp_path / "syn-hidden"), DecisionService()
    servers = [make_server("127.0.0.1", 0, oracle.routes()), make_server("127.0.0.1", 0, d.routes())]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    ob, db = (f"http://127.0.0.1:{s.server_address[1]}" for s in servers)
    try:
        task = _post(f"{ob}/task")
        assert task["synthetic"] is True and task["n_candidates"] == 200
        assert _post(f"{db}/init", {"task": task, "package_dir": task["package_dir"]})["method"] == "gp-ucb"
        prop = _post(f"{db}/propose", {"round": 1, "k": 2})
        res = _post(f"{ob}/run", {"round": 1, "batch": [r["id"] for r in prop["recommendations"]]})
        rec = _post(f"{db}/observe", {"round": 1, "observations": [ro(x) for x in res["results"]]})
        assert rec["state_version_after"] == 1 and len(rec["accepted"]) == 2
        with pytest.raises(urllib.error.HTTPError) as e:
            _post(f"{ob}/run", {"batch": ["NOPE"]})
        assert e.value.code == 400
    finally:
        for s in servers:
            s.shutdown()


def test_token_required_when_configured(tmp_path):
    oracle, _, _ = make(tmp_path)
    server = make_server("127.0.0.1", 0, oracle.routes(), token="s3cret")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        for headers in (None, {"x-perturbpilot-token": "wrong"}):
            with pytest.raises(urllib.error.HTTPError) as e:
                _post(f"{base}/run", {"batch": ["G001"]}, headers)
            assert e.value.code == 401
        assert oracle.replicates == {}  # 被拒的请求没有测量
        res = _post(f"{base}/run", {"batch": ["G001"]}, {"x-perturbpilot-token": "s3cret"})
        assert res["results"][0]["id"] == "G001"
    finally:
        server.shutdown()
