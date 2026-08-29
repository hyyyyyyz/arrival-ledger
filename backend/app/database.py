from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

from .security import hash_password, session_token_digest
from .sync_ingest import item_identity


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

CREATE TABLE IF NOT EXISTS receipt_change_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_event_id TEXT NOT NULL UNIQUE,
    receipt_id INTEGER NOT NULL REFERENCES receipt_events(id) ON DELETE CASCADE,
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('TRACKING_UPDATE')),
    previous_tracking_no TEXT,
    new_tracking_no TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipt_change_events_receipt
    ON receipt_change_events(receipt_id, id DESC);

CREATE TABLE IF NOT EXISTS sync_worker_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_digest TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT 'env',
    created_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    account_key TEXT NOT NULL,
    display_label TEXT,
    source TEXT NOT NULL DEFAULT 'WINDOWS_BROWSER',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(platform, account_key)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform_account_id INTEGER NOT NULL REFERENCES platform_accounts(id),
    platform_order_id TEXT NOT NULL,
    ordered_at TEXT,
    order_status TEXT NOT NULL,
    shop_name TEXT,
    source TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(platform_account_id, platform_order_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
    ON purchase_orders(order_status);

CREATE TABLE IF NOT EXISTS order_arrival_overrides (
    order_id INTEGER PRIMARY KEY REFERENCES purchase_orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'RECEIVED')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT,
    changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_arrival_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_event_id TEXT NOT NULL UNIQUE,
    order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('MARK_RECEIVED', 'MARK_PENDING')),
    previous_effective_status TEXT NOT NULL
        CHECK (previous_effective_status IN ('PENDING', 'REVIEW', 'RECEIVED')),
    new_effective_status TEXT NOT NULL
        CHECK (new_effective_status IN ('PENDING', 'RECEIVED')),
    previous_override_status TEXT
        CHECK (previous_override_status IS NULL OR previous_override_status IN ('PENDING', 'RECEIVED')),
    new_override_status TEXT NOT NULL
        CHECK (new_override_status IN ('PENDING', 'RECEIVED')),
    previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
    new_revision INTEGER NOT NULL CHECK (new_revision > 0),
    reason TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_arrival_events_order
    ON order_arrival_events(order_id, id DESC);

CREATE TABLE IF NOT EXISTS user_management_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id),
    actor_username TEXT NOT NULL,
    actor_display_name TEXT NOT NULL,
    target_user_id INTEGER NOT NULL REFERENCES users(id),
    target_username TEXT NOT NULL,
    target_display_name TEXT NOT NULL,
    target_role TEXT NOT NULL CHECK (target_role IN ('ADMIN', 'RECEIVER')),
    action TEXT NOT NULL CHECK (action IN ('CREATE', 'ACTIVATE', 'DEACTIVATE')),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_management_events_recent
    ON user_management_events(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    item_key TEXT,
    title TEXT NOT NULL,
    sku_text TEXT,
    quantity TEXT NOT NULL,
    unit_price TEXT,
    UNIQUE(order_id, item_key, title, sku_text)
);

CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    courier TEXT,
    courier_normalized TEXT NOT NULL DEFAULT '',
    tracking_no TEXT NOT NULL,
    tracking_no_normalized TEXT NOT NULL,
    package_status TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(courier_normalized, tracking_no_normalized)
);

CREATE INDEX IF NOT EXISTS idx_packages_tracking
    ON packages(tracking_no_normalized);

CREATE TABLE IF NOT EXISTS package_order_links (
    package_id INTEGER NOT NULL REFERENCES packages(id),
    order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    order_item_id INTEGER REFERENCES order_items(id),
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_order_links_item
    ON package_order_links(package_id, order_id, order_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_order_links_null_item
    ON package_order_links(package_id, order_id) WHERE order_item_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_package_order_links_order
    ON package_order_links(order_id);

CREATE TABLE IF NOT EXISTS sync_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL UNIQUE,
    worker_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    account_key TEXT NOT NULL,
    token_digest TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    counts_json TEXT NOT NULL,
    cursor_before TEXT,
    cursor_after TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_batches_rate
    ON sync_batches(token_digest, received_at);

CREATE TABLE IF NOT EXISTS ali1688_sync_state (
    account_key TEXT PRIMARY KEY,
    cursor TEXT,
    last_success_at TEXT,
    last_error_at TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    last_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ali1688_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_ali1688_sync_runs_account
    ON ali1688_sync_runs(account_key, started_at DESC);
"""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    apply: Callable[[sqlite3.Connection], None]


def _exec_script_in_tx(connection: sqlite3.Connection, script: str) -> None:
    for statement in script.split(";"):
        stripped = statement.strip()
        if stripped:
            connection.execute(stripped)


def _migration_initial_schema(connection: sqlite3.Connection) -> None:
    _exec_script_in_tx(connection, SCHEMA)


def _migration_item_identity(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        DELETE FROM order_items
        WHERE id NOT IN (
            SELECT MIN(id) FROM order_items
            GROUP BY order_id, item_key, title, sku_text
        )
        """
    )
    rows = connection.execute(
        "SELECT id, title, sku_text FROM order_items WHERE item_key IS NULL OR item_key = ''"
    ).fetchall()
    for row in rows:
        connection.execute(
            "UPDATE order_items SET item_key = ? WHERE id = ?",
            (item_identity(None, row["title"], row["sku_text"]), row["id"]),
        )
    connection.execute(
        """
        DELETE FROM order_items
        WHERE id NOT IN (
            SELECT MIN(id) FROM order_items
            GROUP BY order_id, item_key
        )
        """
    )
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_order_key
            ON order_items(order_id, item_key)
        """
    )


def _migration_package_links_order_level(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        DELETE FROM package_order_links
        WHERE order_item_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM package_order_links AS p2
            WHERE p2.package_id = package_order_links.package_id
              AND p2.order_id = package_order_links.order_id
              AND p2.order_item_id IS NULL
          )
        """
    )
    connection.execute(
        """
        UPDATE package_order_links SET order_item_id = NULL
        WHERE order_item_id IS NOT NULL
        """
    )


def _migration_ali1688_sync_state(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS ali1688_sync_state (
            account_key TEXT PRIMARY KEY,
            cursor TEXT,
            last_success_at TEXT,
            last_error_at TEXT,
            last_error_code TEXT,
            last_error_message TEXT,
            last_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS ali1688_sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_key TEXT NOT NULL,
            run_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            count INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            error_message TEXT
        )
    """)
    connection.execute("CREATE INDEX IF NOT EXISTS idx_ali1688_sync_runs_account ON ali1688_sync_runs(account_key, started_at DESC)")


def _migration_responsibility_and_manual_arrival(
    connection: sqlite3.Connection,
) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS order_arrival_overrides (
            order_id INTEGER PRIMARY KEY
                REFERENCES purchase_orders(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'RECEIVED')),
            revision INTEGER NOT NULL CHECK (revision > 0),
            actor_user_id INTEGER NOT NULL REFERENCES users(id),
            reason TEXT,
            changed_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS order_arrival_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_event_id TEXT NOT NULL UNIQUE,
            order_id INTEGER NOT NULL
                REFERENCES purchase_orders(id) ON DELETE CASCADE,
            actor_user_id INTEGER NOT NULL REFERENCES users(id),
            action TEXT NOT NULL
                CHECK (action IN ('MARK_RECEIVED', 'MARK_PENDING')),
            previous_effective_status TEXT NOT NULL
                CHECK (previous_effective_status IN ('PENDING', 'REVIEW', 'RECEIVED')),
            new_effective_status TEXT NOT NULL
                CHECK (new_effective_status IN ('PENDING', 'RECEIVED')),
            previous_override_status TEXT
                CHECK (
                    previous_override_status IS NULL
                    OR previous_override_status IN ('PENDING', 'RECEIVED')
                ),
            new_override_status TEXT NOT NULL
                CHECK (new_override_status IN ('PENDING', 'RECEIVED')),
            previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
            new_revision INTEGER NOT NULL CHECK (new_revision > 0),
            reason TEXT,
            created_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS idx_order_arrival_events_order
            ON order_arrival_events(order_id, id DESC)
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS receipt_change_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_event_id TEXT NOT NULL UNIQUE,
            receipt_id INTEGER NOT NULL
                REFERENCES receipt_events(id) ON DELETE CASCADE,
            actor_user_id INTEGER NOT NULL REFERENCES users(id),
            action TEXT NOT NULL CHECK (action IN ('TRACKING_UPDATE')),
            previous_tracking_no TEXT,
            new_tracking_no TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS idx_receipt_change_events_receipt
            ON receipt_change_events(receipt_id, id DESC)
    """)


def _migration_user_management_audit(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS user_management_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_user_id INTEGER NOT NULL REFERENCES users(id),
            actor_username TEXT NOT NULL,
            actor_display_name TEXT NOT NULL,
            target_user_id INTEGER NOT NULL REFERENCES users(id),
            target_username TEXT NOT NULL,
            target_display_name TEXT NOT NULL,
            target_role TEXT NOT NULL
                CHECK (target_role IN ('ADMIN', 'RECEIVER')),
            action TEXT NOT NULL
                CHECK (action IN ('CREATE', 'ACTIVATE', 'DEACTIVATE')),
            created_at TEXT NOT NULL
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS idx_user_management_events_recent
            ON user_management_events(created_at DESC, id DESC)
    """)


MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="initial_schema", apply=_migration_initial_schema),
    Migration(version=2, name="item_identity", apply=_migration_item_identity),
    Migration(
        version=3,
        name="package_links_order_level",
        apply=_migration_package_links_order_level,
    ),
    Migration(
        version=4,
        name="ali1688_sync_state",
        apply=_migration_ali1688_sync_state,
    ),
    Migration(
        version=5,
        name="responsibility_and_manual_arrival",
        apply=_migration_responsibility_and_manual_arrival,
    ),
    Migration(
        version=6,
        name="user_management_audit",
        apply=_migration_user_management_audit,
    ),
)


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
        session_secret: str,
        sync_worker_tokens: tuple[str, ...],
        now: str,
    ) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    version INTEGER NOT NULL,
                    name TEXT NOT NULL UNIQUE,
                    applied_at TEXT NOT NULL
                )
                """
            )
            applied = {
                row["name"]
                for row in connection.execute("SELECT name FROM schema_migrations").fetchall()
            }
            for migration in MIGRATIONS:
                if migration.name in applied:
                    continue
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    migration.apply(connection)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
                        (migration.version, migration.name, now),
                    )
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
            self._ensure_receipt_columns(connection)
            self._sync_worker_tokens(connection, session_secret, sync_worker_tokens, now)
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

    def _ensure_receipt_columns(self, connection: sqlite3.Connection) -> None:
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

    def _sync_worker_tokens(
        self,
        connection: sqlite3.Connection,
        session_secret: str,
        sync_worker_tokens: tuple[str, ...],
        now: str,
    ) -> None:
        digests = [
            session_token_digest(session_secret, token) for token in sync_worker_tokens
        ]
        for digest in digests:
            connection.execute(
                """
                INSERT OR IGNORE INTO sync_worker_tokens(
                    token_digest, label, created_at, revoked_at
                ) VALUES (?, 'env', ?, NULL)
                """,
                (digest, now),
            )
            connection.execute(
                "UPDATE sync_worker_tokens SET revoked_at = NULL WHERE token_digest = ?",
                (digest,),
            )
        if digests:
            placeholders = ",".join("?" for _ in digests)
            connection.execute(
                f"""
                UPDATE sync_worker_tokens SET revoked_at = ?
                WHERE revoked_at IS NULL AND token_digest NOT IN ({placeholders})
                """,
                (now, *digests),
            )
        else:
            connection.execute(
                "UPDATE sync_worker_tokens SET revoked_at = ? WHERE revoked_at IS NULL",
                (now,),
            )
