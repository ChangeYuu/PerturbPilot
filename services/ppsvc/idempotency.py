"""Durable, request-body-bound idempotency records for service mutations."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .jsonhttp import HttpError


class IdempotencyStore:
    """A small atomic JSON journal; callers serialize access around it."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.records: dict[str, dict[str, Any]] = {}
        self._load()

    def lookup(self, namespace: str, request_id: Any, payload: dict[str, Any]) -> dict[str, Any] | None:
        request_id = self.validate_id(request_id)
        if request_id is None:
            return None
        key = f"{namespace}:{request_id}"
        fingerprint = self.fingerprint(payload)
        record = self.records.get(key)
        if record is None:
            return None
        if record.get("fingerprint") != fingerprint:
            raise HttpError(409, f"request_id {request_id!r} was already used with a different request")
        return record

    def save(
        self,
        namespace: str,
        request_id: Any,
        payload: dict[str, Any],
        response: dict[str, Any],
        state: dict[str, Any] | None = None,
    ) -> None:
        request_id = self.validate_id(request_id)
        if request_id is None:
            return
        key = f"{namespace}:{request_id}"
        self.records[key] = {
            "namespace": namespace,
            "request_id": request_id,
            "fingerprint": self.fingerprint(payload),
            "response": response,
            "state": state or {},
        }
        self._save()

    @staticmethod
    def validate_id(request_id: Any) -> str | None:
        if request_id is None:
            return None
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 256:
            raise HttpError(400, "request_id must be a non-empty string of at most 256 characters")
        return request_id

    @staticmethod
    def fingerprint(payload: dict[str, Any]) -> str:
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"cannot load idempotency journal {self.path}: {exc}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("records", {}), dict):
            raise RuntimeError(f"invalid idempotency journal {self.path}")
        self.records = data["records"]

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_name(self.path.name + ".tmp")
        temp.write_text(json.dumps({"version": 1, "records": self.records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temp, self.path)
