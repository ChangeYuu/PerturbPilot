"""极简 JSON-over-HTTP 服务器，只用标准库。"""

from __future__ import annotations

import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

Route = Callable[[dict[str, Any]], Any]


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


TOKEN_HEADER = "x-perturbpilot-token"


def make_server(
    host: str, port: int, routes: dict[tuple[str, str], Route], token: str | None = None
) -> ThreadingHTTPServer:
    """routes 的键是 (方法, 路径)，处理函数收到请求体（GET 时为空 dict），返回可 JSON 化的对象。

    给了 token 时，每个请求都要带 x-perturbpilot-token 头且值相等，否则 401。
    """
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def _handle(self, method: str) -> None:
            if token and not hmac.compare_digest(self.headers.get(TOKEN_HEADER, ""), token):
                self._send(401, {"error": "missing or wrong service token"})
                return
            route = routes.get((method, self.path.split("?", 1)[0]))
            if route is None:
                self._send(404, {"error": f"no route {method} {self.path}"})
                return
            try:
                body: dict[str, Any] = {}
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    body = json.loads(self.rfile.read(length).decode("utf-8"))
                    if not isinstance(body, dict):
                        raise HttpError(400, "request body must be a JSON object")
                with lock:
                    result = route(body)
                self._send(200, result)
            except HttpError as e:
                self._send(e.status, {"error": e.message})
            except (ValueError, KeyError, TypeError) as e:
                self._send(400, {"error": f"{type(e).__name__}: {e}"})

        def do_GET(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._handle("POST")

        def _send(self, status: int, payload: Any) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: Any) -> None:  # 静默默认访问日志
            pass

    return ThreadingHTTPServer((host, port), Handler)
