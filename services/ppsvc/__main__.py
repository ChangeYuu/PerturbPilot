"""启动 oracle 和决策模块两个 HTTP 服务。

用法：
  python -m ppsvc --seed 0
  python -m ppsvc --seed 0 --oracle-port 8701 --decision-port 8702
"""

from __future__ import annotations

import argparse
import threading

from .decision import GpUcbDecision
from .jsonhttp import make_server
from .oracle import Oracle, TaskConfig


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="ppsvc")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--oracle-port", type=int, default=8701)
    p.add_argument("--decision-port", type=int, default=8702)
    p.add_argument("--rounds", type=int, default=TaskConfig.max_rounds)
    p.add_argument("--batch-size", type=int, default=TaskConfig.batch_size)
    args = p.parse_args(argv)

    cfg = TaskConfig(seed=args.seed, max_rounds=args.rounds, batch_size=args.batch_size)
    oracle = Oracle(cfg)
    card = oracle.task.card()
    decision = GpUcbDecision(card["candidates"], noise_sd=cfg.noise_sd)

    servers = [
        make_server(args.host, args.oracle_port, oracle.routes()),
        make_server(args.host, args.decision_port, decision.routes()),
    ]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"oracle   http://{args.host}:{args.oracle_port}  ({card['task_id']}, synthetic)", flush=True)
    print(f"decision http://{args.host}:{args.decision_port}", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for s in servers:
            s.shutdown()


if __name__ == "__main__":
    main()
