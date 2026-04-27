#!/usr/bin/env python3
"""SQLite-backed persistence for dashboard inference runs."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional


class RunStore:
    def __init__(self, db_path: str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                  id TEXT PRIMARY KEY,
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL,
                  status TEXT NOT NULL,
                  prompt TEXT NOT NULL,
                  market_id TEXT,
                  amount_usdc REAL NOT NULL,
                  min_verified_peers INTEGER NOT NULL,
                  verify INTEGER NOT NULL,
                  summary_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS run_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  run_id TEXT NOT NULL,
                  ts REAL NOT NULL,
                  event TEXT NOT NULL,
                  data_json TEXT NOT NULL,
                  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_runs_created_at
                  ON runs(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_run_events_run_id_id
                  ON run_events(run_id, id);
                """
            )

    def create_run(
        self,
        *,
        run_id: str,
        prompt: str,
        market_id: Optional[str],
        amount_usdc: float,
        min_verified_peers: int,
        verify: bool,
    ) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO runs (
                  id, created_at, updated_at, status, prompt, market_id,
                  amount_usdc, min_verified_peers, verify, summary_json
                )
                VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, '{}')
                """,
                (
                    run_id,
                    now,
                    now,
                    prompt,
                    market_id,
                    amount_usdc,
                    min_verified_peers,
                    1 if verify else 0,
                ),
            )

    def append_event(
        self,
        *,
        run_id: str,
        ts: float,
        event: str,
        data: Any,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO run_events (run_id, ts, event, data_json)
                VALUES (?, ?, ?, ?)
                """,
                (run_id, ts, event, json.dumps(data, default=str)),
            )
            conn.execute(
                "UPDATE runs SET updated_at = ? WHERE id = ?",
                (ts, run_id),
            )

    def update_run(self, *, run_id: str, status: str, summary: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, summary_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, json.dumps(summary, default=str), time.time(), run_id),
            )

    def list_runs(self, *, limit: int = 25) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 100))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, created_at, updated_at, status, prompt, market_id,
                       amount_usdc, min_verified_peers, verify, summary_json
                FROM runs
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [self._run_row_to_dict(row) for row in rows]

    def get_run(self, run_id: str) -> Optional[dict[str, Any]]:
        with self._connect() as conn:
            run = conn.execute(
                """
                SELECT id, created_at, updated_at, status, prompt, market_id,
                       amount_usdc, min_verified_peers, verify, summary_json
                FROM runs
                WHERE id = ?
                """,
                (run_id,),
            ).fetchone()
            if run is None:
                return None
            events = conn.execute(
                """
                SELECT id, ts, event, data_json
                FROM run_events
                WHERE run_id = ?
                ORDER BY id ASC
                """,
                (run_id,),
            ).fetchall()

        payload = self._run_row_to_dict(run)
        payload["events"] = [self._event_row_to_dict(row) for row in events]
        return payload

    def delete_run(self, run_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            return cur.rowcount > 0

    @staticmethod
    def _run_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "status": row["status"],
            "prompt": row["prompt"],
            "marketId": row["market_id"],
            "amountUsdc": row["amount_usdc"],
            "minVerifiedPeers": row["min_verified_peers"],
            "verify": bool(row["verify"]),
            "summary": json.loads(row["summary_json"] or "{}"),
        }

    @staticmethod
    def _event_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "ts": row["ts"],
            "event": row["event"],
            "data": json.loads(row["data_json"]),
        }
