"""启动 oracle 和决策模块两个 HTTP 服务。

用法：
  python -m ppsvc                                  # 合成任务（种子 0）
  python -m ppsvc --seed 3 --rounds 8 --batch-size 6
  python -m ppsvc --task D:\\pp-tasks\\il2 --hidden D:\\pp-tasks-hidden\\il2   # 任务包和它的隐藏数据
  python -m ppsvc --task <目录> --hidden <目录> --decision coverage

隐藏数据（scores.csv 等）放在任务包外面；给了 --task 就必须给 --hidden。

--decision：auto（默认，有嵌入特征用 gp-ucb，否则 coverage）、gp-ucb、coverage。
决策模块启动时还没读任务，插件开任务时调 /init 把任务包交给它。

设了环境变量 PERTURBPILOT_SERVICE_TOKEN 时，两个服务都只接受带同一个值的
x-perturbpilot-token 请求头的请求（插件从同名环境变量读，分析用的 Python 子进程拿不到）。
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import threading
from pathlib import Path

from .decision import METHODS, DecisionService
from .jsonhttp import make_server
from .oracle import Oracle
from .task import Package, write_synthetic_package

TOKEN_ENV = "PERTURBPILOT_SERVICE_TOKEN"


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="ppsvc")
    p.add_argument("--task", help="任务包目录；不给就生成合成任务")
    p.add_argument("--hidden", help="任务包的隐藏数据目录（在任务包外面）；给了 --task 就必须给")
    p.add_argument("--decision", choices=METHODS, default="auto")
    p.add_argument("--seed", type=int, default=0, help="合成任务的种子")
    p.add_argument("--rounds", type=int, default=10, help="合成任务的轮数")
    p.add_argument("--batch-size", type=int, default=6, help="合成任务每轮的批量")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--oracle-port", type=int, default=8701)
    p.add_argument("--decision-port", type=int, default=8702)
    args = p.parse_args(argv)

    if args.task:
        if not args.hidden:
            p.error("--task needs --hidden (the directory with the hidden scores, outside the task package)")
        root, hidden = Path(args.task), Path(args.hidden)
    else:
        if args.hidden:
            p.error("--hidden only goes with --task")
        root = Path(tempfile.mkdtemp(prefix="pp-synthetic-"))
        hidden = Path(tempfile.mkdtemp(prefix="pp-synthetic-hidden-"))
        write_synthetic_package(root, hidden, seed=args.seed, max_rounds=args.rounds, batch_size=args.batch_size)
    package = Package.load(root)
    oracle = Oracle(package, hidden)
    decision = DecisionService(args.decision)

    token = os.environ.get(TOKEN_ENV) or None
    servers = [
        make_server(args.host, args.oracle_port, oracle.routes(), token),
        make_server(args.host, args.decision_port, decision.routes(), token),
    ]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    kind = "synthetic" if package.card.get("synthetic") else "task package"
    print(f"oracle   http://{args.host}:{args.oracle_port}  ({package.card['task_id']}, {kind}, {len(package.ids)} candidates)", flush=True)
    print(f"         package {package.root}", flush=True)
    print(f"decision http://{args.host}:{args.decision_port}  (method {args.decision})", flush=True)
    if token is None:
        print(f"warning: {TOKEN_ENV} is not set, the services accept requests from anyone on this machine", file=sys.stderr, flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for s in servers:
            s.shutdown()


if __name__ == "__main__":
    main()
