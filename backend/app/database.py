from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .security import hash_password


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN', 'RECEIVER')),
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_digest TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_active
    ON sessions(token_digest, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS receipt_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_event_id TEXT NOT NULL UNIQUE,
    operator_user_id INTEGER NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL DEFAULT 'RECEIVE' CHECK (event_type IN ('RECEIVE')),
    input_method TEXT NOT NULL DEFAULT 'PHOTO_CAPTURE'
        CHECK (input_method IN ('PHOTO_CAPTURE')),
    captured_at TEXT NOT NULL,
    server_received_at TEXT NOT NULL,
    device_id TEXT NOT NULL,
    barcode_candidate TEXT,
    tracking_no TEXT,
    tracking_no_normalized TEXT,
    duplicate_of_receipt_id INTEGER REFERENCES receipt_events(id),
    evidence_status TEXT NOT NULL DEFAULT 'READY'
        CHECK (evidence_status IN ('PENDING', 'READY', 'FAILED')),
    photo_storage_path TEXT NOT NULL,
    photo_original_name TEXT,
    photo_content_type TEXT NOT NULL,
    photo_sha256 TEXT NOT NULL,
    photo_size INTEGER NOT NULL CHECK (photo_size > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_recent
    ON receipt_events(server_received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_tracking
    ON receipt_events(tracking_no_normalized);
"""


class Database:
    def __init__(self, path: Path):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def initialize(
        self,
        *,
        bootstrap_username: str,
        bootstrap_password: str | None,
        bootstrap_display_name: str,
        now: str,
    ) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
            connection.executescript(SCHEMA)
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(receipt_events)").fetchall()
            }
            if "duplicate_of_receipt_id" not in columns:
                connection.execute(
                    """
                    ALTER TABLE receipt_events
                    ADD COLUMN duplicate_of_receipt_id INTEGER REFERENCES receipt_events(id)
                    """
                )
            user_count = connection.execute(
                "SELECT COUNT(*) AS count FROM users"
            ).fetchone()["count"]
            if user_count == 0:
                if not bootstrap_password:
                    raise RuntimeError(
                        "users table is empty; set BOOTSTRAP_ADMIN_PASSWORD for first startup"
                    )
                connection.execute(
                    """
                    INSERT INTO users(
                        username, display_name, role, password_hash, is_active, created_at
                    ) VALUES (?, ?, 'ADMIN', ?, 1, ?)
                    """,
                    (
                        bootstrap_username.strip(),
                        bootstrap_display_name.strip() or bootstrap_username.strip(),
                        hash_password(bootstrap_password),
                        now,
                    ),
                )
            connection.commit()
