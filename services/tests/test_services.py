import json
import threading
import urllib.request

import numpy as np
import pytest

from ppsvc.decision import GpUcbDecision
from ppsvc.jsonhttp import HttpError, make_server
from ppsvc.oracle import Oracle, TaskConfig


def make(seed=0):
    oracle = Oracle(TaskConfig(seed=seed))
    card = oracle.task.card()
    return oracle, card, GpUcbDecision(card["candidates"], noise_sd=oracle.task.cfg.noise_sd)


def test_task_is_deterministic_per_seed():
    a, b, c = (Oracle(TaskConfig(seed=s)).task for s in (1, 1, 2))
    assert np.array_equal(a.truth, b.truth)
    assert not np.array_equal(a.truth, c.truth)


def test_readout_independent_of_submission_order():
    o1, _, _ = make()
    o2, _, _ = make()
    r1 = o1.run({"round": 1, "batch": ["G001", "G002"]})["results"]
    r2 = o2.run({"round": 1, "batch": ["G002", "G001"]})["results"]
    assert {r["id"]: r["value"] for r in r1} == {r["id"]: r["value"] for r in r2}


def test_replicates_differ_and_reset_restores():
    o, _, _ = make()
    v0 = o.run({"batch": ["G005"]})["results"][0]["value"]
    v1 = o.run({"batch": ["G005"]})["results"][0]["value"]
    assert v0 != v1
    o.reset({"replicates": {"G005": 1}})
    assert o.run({"batch": ["G005"]})["results"][0]["value"] == v1


def test_oracle_rejects_bad_batches():
    o, _, _ = make()
    with pytest.raises(HttpError):
        o.run({"batch": []})
    with pytest.raises(HttpError):
        o.run({"batch": ["NOPE"]})
    with pytest.raises(HttpError):
        o.run({"batch": [f"G{i:03d}" for i in range(o.task.cfg.batch_size + 1)]})


def test_observe_receipt_and_versioning():
    _, _, d = make()
    p0 = d.propose({"round": 1, "k": 3})
    assert p0["state_version"] == 0 and len(p0["recommendations"]) == 3
    receipt = d.observe(
        {"round": 1, "observations": [{"id": "G001", "value": 1.0}, {"id": "BAD", "value": 1.0}, {"id": "G002", "value": float("nan")}]}
    )
    assert receipt["accepted"] == ["G001"]
    assert {r["reason"] for r in receipt["rejected"]} == {"unknown_id", "non_finite_value"}
    assert (receipt["state_version_before"], receipt["state_version_after"]) == (0, 1)
    p1 = d.propose({"round": 2, "k": 3})
    assert p1["state_version"] == 1
    assert "G001" not in [r["id"] for r in p1["recommendations"]]


def test_observation_changes_posterior():
    _, _, d = make()
    mu0, sd0 = d.posterior()
    d.observe({"observations": [{"id": "G010", "value": 2.0}]})
    mu1, sd1 = d.posterior()
    i = d.index["G010"]
    assert sd1[i] < sd0[i]
    assert abs(mu1[i] - 2.0) < abs(mu0[i] - 2.0)


def test_snapshot_restore_roundtrip():
    _, _, d = make()
    d.observe({"observations": [{"id": "G003", "value": 0.5}, {"id": "G004", "value": 1.5}]})
    snap = d.snapshot({})
    before = d.propose({"k": 5})
    _, _, d2 = make()
    d2.restore({"snapshot": snap})
    after = d2.propose({"k": 5})
    assert before["recommendations"] == after["recommendations"]
    assert after["state_version"] == snap["state_version"]


def test_closed_loop_beats_random_on_average():
    """GP-UCB 的闭环在合成任务上应当比随机选择找到更好的候选（多个种子平均）。"""
    gains = []
    for seed in range(5):
        oracle, _, d = make(seed)
        truth = oracle.task.truth
        for r in range(1, 9):
            batch = [x["id"] for x in d.propose({"round": r, "k": 6})["recommendations"]]
            res = oracle.run({"round": r, "batch": batch})["results"]
            d.observe({"round": r, "observations": [{"id": x["id"], "value": x["value"]} for x in res]})
        best_found = max(truth[oracle.task.index_of(c)] for c, _ in d.obs)
        rng = np.random.default_rng(seed)
        random_best = max(truth[rng.choice(len(truth), 48, replace=False)])
        gains.append(best_found - random_best)
    assert np.mean(gains) > 0


def _post(url, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def test_http_roundtrip():
    oracle, _, d = make()
    servers = [make_server("127.0.0.1", 0, oracle.routes()), make_server("127.0.0.1", 0, d.routes())]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    ob, db = (f"http://127.0.0.1:{s.server_address[1]}" for s in servers)
    try:
        assert _post(f"{ob}/task")["synthetic"] is True
        prop = _post(f"{db}/propose", {"round": 1, "k": 2})
        res = _post(f"{ob}/run", {"round": 1, "batch": [r["id"] for r in prop["recommendations"]]})
        rec = _post(f"{db}/observe", {"round": 1, "observations": res["results"]})
        assert rec["state_version_after"] == 1 and len(rec["accepted"]) == 2
        with pytest.raises(urllib.error.HTTPError) as e:
            _post(f"{ob}/run", {"batch": ["NOPE"]})
        assert e.value.code == 400
    finally:
        for s in servers:
            s.shutdown()


def test_token_required_when_configured():
    oracle, _, _ = make()
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
