from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from app.database import Database, Migration, SCHEMA, _exec_script_in_tx
from app.main import create_app
from app.sync_ingest import canonical_payload_digest, item_identity

from test_sync_api import batch_payload, post_batch


def canonical_digest(payload: dict) -> str:
    return canonical_payload_digest(
        json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode(
            "utf-8"
        )
    )


def insert_error_batch(client: TestClient, payload: dict) -> None:
    digest = canonical_digest(payload)
    with client.app.state.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO sync_batches(
                batch_id, worker_id, platform, account_key, token_digest,
                payload_sha256, status, counts_json, cursor_before, cursor_after,
                error_code, error_message, started_at, finished_at, received_at
            ) VALUES (?, ?, ?, ?, 'td', ?, 'ERROR', '{"created":0,"updated":0,"skipped":0,"errors":1}',
                      NULL, NULL, 'INGEST_FAILED', 'injected', ?, ?, ?)
            """,
            (
                payload["batch_id"],
                payload["worker_id"],
                payload["platform"],
                payload["platform_account_key"],
                digest,
                payload["started_at"],
                payload["finished_at"],
                payload["finished_at"],
            ),
        )
        connection.commit()


def test_error_batch_retry_reprocesses_safely(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-error-retry-0001")
    insert_error_batch(client, payload)
    response = post_batch(client, payload, sync_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["created"] == 1
    assert body["cursor_accepted"] is True
    with client.app.state.database.connect() as connection:
        batches = connection.execute(
            "SELECT status, counts_json FROM sync_batches WHERE batch_id = 'b-error-retry-0001'"
        ).fetchall()
        assert len(batches) == 1
        assert batches[0]["status"] == "OK"
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 1


def test_error_batch_conflicting_content_returns_409(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-error-conflict-0001")
    insert_error_batch(client, payload)
    changed = batch_payload("b-error-conflict-0001")
    changed["orders"][0]["platform_order_id"] = "260813-9999"
    response = post_batch(client, changed, sync_headers)
    assert response.status_code == 409
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 0


def test_idempotency_key_must_match_batch_id(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-idem-key-0001")
    missing = client.post(
        "/api/sync/v1/batches", json=payload, headers=sync_headers
    )
    assert missing.status_code == 422
    mismatched = client.post(
        "/api/sync/v1/batches",
        json=payload,
        headers={**sync_headers, "Idempotency-Key": "different-batch-id"},
    )
    assert mismatched.status_code == 422


def test_duplicate_platform_order_id_in_batch_is_rejected(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-dup-order-0001")
    payload["orders"] = batch_payload()["orders"] * 2
    assert post_batch(client, payload, sync_headers).status_code == 422


def test_blank_ids_and_ordering_are_rejected(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    for payload in (
        batch_payload(batch_id="   "),
        batch_payload("b-blank-0002", worker_id="  "),
        batch_payload(
            "b-blank-0003",
            finished_at="2026-08-13T01:00:00.000Z",
        ),
        batch_payload(
            "b-blank-0004",
            orders=[
                {
                    **batch_payload()["orders"][0],
                    "platform_order_id": "   ",
                }
            ],
        ),
    ):
        assert post_batch(client, payload, sync_headers).status_code == 422


def test_sync_max_batch_orders_is_enforced(
    client: TestClient, settings, sync_headers: dict[str, str]
) -> None:
    limited = replace(settings, sync_max_batch_orders=2)
    with TestClient(create_app(limited)) as test_client:
        headers = {**sync_headers}
        payload = batch_payload("b-order-limit-0001")
        payload["orders"] = [
            {**batch_payload()["orders"][0], "platform_order_id": f"260813-{index:04d}"}
            for index in range(3)
        ]
        response = post_batch(test_client, payload, headers)
        assert response.status_code == 422


def test_item_fingerprint_prevents_duplicate_rows(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-item-fp-0001")
    payload["orders"][0]["items"] = [
        {"item_key": None, "title": "无ID商品", "sku_text": "标准", "quantity": 1, "unit_price": None},
        {"item_key": None, "title": "无ID商品", "sku_text": "标准", "quantity": 1, "unit_price": None},
    ]
    assert post_batch(client, payload, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM order_items").fetchone()["c"] == 1
    second = batch_payload("b-item-fp-0002")
    second["orders"][0]["items"] = [
        {"item_key": None, "title": "无ID商品", "sku_text": "标准", "quantity": 3, "unit_price": "9.99"},
    ]
    assert post_batch(client, second, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM order_items").fetchone()["c"] == 1
        row = connection.execute("SELECT quantity, unit_price FROM order_items").fetchone()
        assert row["quantity"] == "3"
        assert row["unit_price"] == "9.99"


def test_item_identity_matches_platform_id_first() -> None:
    assert item_identity("item-1", "标题", None) == "item-1"
    fingerprint = item_identity(None, "标题", "规格")
    assert fingerprint.startswith("fp:")
    assert fingerprint == item_identity(None, " 标题 ", " 规格 ")
    assert fingerprint != item_identity(None, "另一标题", "规格")


def test_item_and_package_changes_update_in_place(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-upsert-0001")
    assert post_batch(client, first, sync_headers).status_code == 200
    second = batch_payload("b-upsert-0002")
    second["orders"][0]["items"][0]["quantity"] = 5
    second["orders"][0]["items"][0]["unit_price"] = "20.00"
    second["orders"][0]["items"][0]["sku_text"] = "规格:加大"
    second["orders"][0]["packages"] = [
        {"courier": "顺丰速运", "tracking_no": "SF1234567890000", "status": "DELIVERED"}
    ]
    response = post_batch(client, second, sync_headers)
    assert response.status_code == 200
    assert response.json()["updated"] == 1
    assert response.json()["skipped"] == 0
    with client.app.state.database.connect() as connection:
        items = connection.execute(
            "SELECT quantity, unit_price, sku_text FROM order_items"
        ).fetchall()
        assert len(items) == 1
        assert items[0]["quantity"] == "5"
        assert items[0]["unit_price"] == "20.00"
        assert items[0]["sku_text"] == "规格:加大"
        packages = connection.execute(
            "SELECT courier, package_status FROM packages"
        ).fetchall()
        assert len(packages) == 1
        assert packages[0]["package_status"] == "DELIVERED"


def test_unknown_then_known_courier_merges_one_physical_package(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-courier-0001")
    first["orders"][0]["packages"] = [
        {"courier": None, "tracking_no": "8800123456789", "status": None}
    ]
    assert post_batch(client, first, sync_headers).status_code == 200
    second = batch_payload("b-courier-0002")
    second["orders"][0]["packages"] = [
        {"courier": "中通快递", "tracking_no": "8800123456789", "status": "SHIPPED"}
    ]
    assert post_batch(client, second, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        packages = connection.execute(
            "SELECT courier, courier_normalized, package_status FROM packages"
        ).fetchall()
        assert len(packages) == 1
        assert packages[0]["courier_normalized"] == "中通快递"
        assert packages[0]["package_status"] == "SHIPPED"


def test_fingerprint_items_are_reconciled_authoritatively(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-reconcile-0001")
    first["orders"][0]["items"] = [
        {"item_key": None, "title": "旧标题商品", "sku_text": "标准", "quantity": 1, "unit_price": None},
        {"item_key": None, "title": "要被移除的商品", "sku_text": "标准", "quantity": 1, "unit_price": None},
    ]
    assert post_batch(client, first, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM order_items").fetchone()["c"] == 2

    second = batch_payload("b-reconcile-0002")
    second["orders"][0]["items"] = [
        {"item_key": None, "title": "改名后的商品", "sku_text": "标准", "quantity": 2, "unit_price": None},
    ]
    assert post_batch(client, second, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        rows = connection.execute("SELECT title, quantity FROM order_items ORDER BY id").fetchall()
        assert [row["title"] for row in rows] == ["改名后的商品"]
        assert [row["quantity"] for row in rows] == ["2"]


def test_platform_keyed_items_are_not_deleted(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-reconcile-key-0001")
    first["orders"][0]["items"] = [
        {"item_key": "platform-item-1", "title": "平台商品", "sku_text": None, "quantity": 1, "unit_price": None},
        {"item_key": None, "title": "指纹商品", "sku_text": None, "quantity": 1, "unit_price": None},
    ]
    assert post_batch(client, first, sync_headers).status_code == 200

    second = batch_payload("b-reconcile-key-0002")
    second["orders"][0]["items"] = [
        {"item_key": "platform-item-1", "title": "平台商品", "sku_text": None, "quantity": 1, "unit_price": None},
    ]
    assert post_batch(client, second, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        rows = connection.execute(
            "SELECT item_key, title FROM order_items ORDER BY id"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["item_key"] == "platform-item-1"


def test_two_known_couriers_never_merge(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-courier-known-0001")
    first["orders"][0]["packages"] = [
        {"courier": "顺丰速运", "tracking_no": "8800123456789", "status": "SHIPPED"}
    ]
    assert post_batch(client, first, sync_headers).status_code == 200

    second = batch_payload("b-courier-known-0002")
    second["orders"][0]["packages"] = [
        {"courier": "中通快递", "tracking_no": "8800123456789", "status": "SHIPPED"}
    ]
    assert post_batch(client, second, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        packages = connection.execute(
            "SELECT courier_normalized FROM packages ORDER BY id"
        ).fetchall()
        assert len(packages) == 2
        assert {row["courier_normalized"] for row in packages} == {"顺丰速运", "中通快递"}


def test_package_links_stay_order_level_even_for_single_items(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-link-item-0001")
    assert post_batch(client, payload, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        link = connection.execute(
            """
            SELECT package_order_links.order_item_id AS oi
            FROM package_order_links
            JOIN purchase_orders ON purchase_orders.id = package_order_links.order_id
            """
        ).fetchone()
        assert link is not None
        assert link["oi"] is None


def test_multi_item_orders_leave_links_order_level(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-link-multi-item-0001")
    payload["orders"][0]["items"] = [
        {"item_key": "i-1", "title": "商品甲", "sku_text": None, "quantity": 1, "unit_price": None},
        {"item_key": "i-2", "title": "商品乙", "sku_text": None, "quantity": 1, "unit_price": None},
    ]
    assert post_batch(client, payload, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        link = connection.execute(
            """
            SELECT package_order_links.order_item_id AS oi
            FROM package_order_links
            JOIN purchase_orders ON purchase_orders.id = package_order_links.order_id
            """
        ).fetchone()
        assert link is not None
        assert link["oi"] is None


def test_known_then_unknown_courier_does_not_create_duplicate(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-courier-rev-0001")
    first["orders"][0]["packages"] = [
        {"courier": "中通快递", "tracking_no": "8800123456789", "status": "SHIPPED"}
    ]
    assert post_batch(client, first, sync_headers).status_code == 200
    second = batch_payload("b-courier-rev-0002")
    second["orders"][0]["packages"] = [
        {"courier": None, "tracking_no": "8800123456789", "status": None}
    ]
    assert post_batch(client, second, sync_headers).status_code == 200
    with client.app.state.database.connect() as connection:
        packages = connection.execute(
            "SELECT courier_normalized FROM packages"
        ).fetchall()
        assert len(packages) == 1
        assert packages[0]["courier_normalized"] == "中通快递"


def test_migration_upgrades_old_database_and_keeps_receipts(
    tmp_path, client: TestClient
) -> None:
    old_path = tmp_path / "old" / "arrival.db"
    old_path.parent.mkdir(parents=True)
    raw = sqlite3.connect(old_path)
    raw.row_factory = sqlite3.Row
    _exec_script_in_tx(raw, SCHEMA)
    raw.execute(
        """
        INSERT INTO users(id, username, display_name, role, password_hash, is_active, created_at)
        VALUES (1, 'admin', '旧管理员', 'ADMIN', 'x', 1, '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO receipt_events(
            id, client_event_id, operator_user_id, event_type, input_method,
            captured_at, server_received_at, device_id, tracking_no,
            tracking_no_normalized, evidence_status, photo_storage_path,
            photo_content_type, photo_sha256, photo_size, created_at, updated_at
        ) VALUES (
            1, 'legacy-event-0001', 1, 'RECEIVE', 'PHOTO_CAPTURE',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z', 'legacy-device',
            'SF0000000000000', 'SF0000000000000', 'READY', '2026/08/legacy.jpg',
            'image/jpeg', 'aa', 10, '2026-08-01T00:00:01.000Z', '2026-08-01T00:00:01.000Z'
        )
        """
    )
    raw.execute(
        """
        INSERT INTO platform_accounts(id, platform, account_key, source, created_at, updated_at)
        VALUES (1, 'pdd', 'pdd-main', 'WINDOWS_BROWSER', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO purchase_orders(
            id, platform_account_id, platform_order_id, ordered_at, order_status,
            shop_name, source, last_seen_at, created_at, updated_at
        ) VALUES (1, 1, 'legacy-order-0001', NULL, 'UNKNOWN', NULL,
                  'WINDOWS_BROWSER', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO order_items(id, order_id, item_key, title, sku_text, quantity, unit_price)
        VALUES (1, 1, NULL, '旧商品A', '标准', '2', NULL)
        """
    )
    raw.execute(
        """
        INSERT INTO order_items(id, order_id, item_key, title, sku_text, quantity, unit_price)
        VALUES (2, 1, NULL, '旧商品A', '标准', '2', NULL)
        """
    )
    raw.commit()
    raw.close()

    database = Database(old_path)
    database.initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=("test-sync-worker-token-0001",),
        now="2026-08-13T00:00:00.000Z",
    )
    with database.connect() as connection:
        receipts = connection.execute(
            "SELECT client_event_id FROM receipt_events"
        ).fetchall()
        assert [row["client_event_id"] for row in receipts] == ["legacy-event-0001"]
        items = connection.execute(
            "SELECT id, item_key FROM order_items ORDER BY id"
        ).fetchall()
        assert len(items) == 1
        assert items[0]["item_key"].startswith("fp:")
        migrations = connection.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version"
        ).fetchall()
        assert [row["version"] for row in migrations] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert "order_arrival_overrides" in tables
        assert "order_arrival_events" in tables
        assert "receipt_change_events" in tables
        assert "user_management_events" in tables
        assert "platform_account_sync_state" in tables


def test_fp_item_title_sku_change_with_package_is_safe(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = batch_payload("b-fp-pkg-0001")
    first["orders"][0]["items"] = [
        {"item_key": None, "title": "杯子", "sku_text": "红色", "quantity": 1, "unit_price": None}
    ]
    assert post_batch(client, first, sync_headers).status_code == 200

    second = batch_payload("b-fp-pkg-0002")
    second["orders"][0]["items"] = [
        {"item_key": None, "title": "杯子", "sku_text": "蓝色", "quantity": 1, "unit_price": None}
    ]
    response = post_batch(client, second, sync_headers)
    assert response.status_code == 200
    with client.app.state.database.connect() as connection:
        items = connection.execute("SELECT sku_text FROM order_items").fetchall()
        assert len(items) == 1
        assert items[0]["sku_text"] == "蓝色"
        links = connection.execute("SELECT order_item_id FROM package_order_links").fetchall()
        assert len(links) == 1
        assert links[0]["order_item_id"] is None


def test_legacy_nonnull_links_are_nullified_and_deduped_on_upgrade(
    tmp_path, client: TestClient
) -> None:
    old_path = tmp_path / "links" / "arrival.db"
    old_path.parent.mkdir(parents=True)
    raw = sqlite3.connect(old_path)
    raw.row_factory = sqlite3.Row
    _exec_script_in_tx(raw, SCHEMA)
    raw.execute(
        """
        INSERT INTO users(id, username, display_name, role, password_hash, is_active, created_at)
        VALUES (1, 'admin', '旧管理员', 'ADMIN', 'x', 1, '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO platform_accounts(id, platform, account_key, source, created_at, updated_at)
        VALUES (1, 'pdd', 'pdd-main', 'WINDOWS_BROWSER', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO purchase_orders(
            id, platform_account_id, platform_order_id, ordered_at, order_status,
            shop_name, source, last_seen_at, created_at, updated_at
        ) VALUES (1, 1, 'legacy-links-0001', NULL, 'UNKNOWN', NULL,
                  'WINDOWS_BROWSER', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO order_items(id, order_id, item_key, title, sku_text, quantity, unit_price)
        VALUES (1, 1, 'legacy-item-1', '旧商品', '标准', '2', NULL)
        """
    )
    raw.execute(
        """
        INSERT INTO packages(id, courier, courier_normalized, tracking_no, tracking_no_normalized,
                             package_status, source, created_at, updated_at)
        VALUES (1, NULL, '', '8800123456789', '8800123456789', NULL,
                'WINDOWS_BROWSER', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO package_order_links(package_id, order_id, order_item_id, created_at)
        VALUES (1, 1, NULL, '2026-08-01T00:00:00.000Z')
        """
    )
    raw.execute(
        """
        INSERT INTO package_order_links(package_id, order_id, order_item_id, created_at)
        VALUES (1, 1, 1, '2026-08-01T00:00:00.000Z')
        """
    )
    raw.commit()
    raw.close()

    database = Database(old_path)
    database.initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-13T00:00:00.000Z",
    )
    with database.connect() as connection:
        links = connection.execute(
            "SELECT order_item_id FROM package_order_links"
        ).fetchall()
        assert len(links) == 1
        assert links[0]["order_item_id"] is None
        migrations = connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
        assert [row["version"] for row in migrations] == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]


def test_photo_library_migration_preserves_duplicate_receipts_and_audit_history(
    tmp_path,
) -> None:
    """A genuine pre-v10 receipt schema must migrate without dropping evidence."""
    path = tmp_path / "photo-library-v8" / "arrival.db"
    path.parent.mkdir(parents=True)
    raw = sqlite3.connect(path)
    raw.row_factory = sqlite3.Row
    _exec_script_in_tx(raw, SCHEMA)
    raw.execute(
        """
        INSERT INTO users(id, username, display_name, role, password_hash, is_active, created_at)
        VALUES (1, 'admin', '旧管理员', 'ADMIN', 'x', 1, '2026-08-01T00:00:00.000Z')
        """
    )
    # Reconstruct the v8 CHECK constraint while retaining the surrounding
    # current schema.  This mirrors a real database created before gallery
    # input_method was introduced.
    raw.execute("DROP TABLE receipt_change_events")
    raw.execute("DROP INDEX IF EXISTS idx_receipts_recent")
    raw.execute("DROP INDEX IF EXISTS idx_receipts_tracking")
    raw.execute("DROP TABLE receipt_events")
    raw.execute(
        """
        CREATE TABLE receipt_events (
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
        )
        """
    )
    raw.execute("CREATE INDEX idx_receipts_recent ON receipt_events(server_received_at DESC, id DESC)")
    raw.execute("CREATE INDEX idx_receipts_tracking ON receipt_events(tracking_no_normalized)")
    raw.execute(
        """
        CREATE TABLE receipt_change_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_event_id TEXT NOT NULL UNIQUE,
            receipt_id INTEGER NOT NULL REFERENCES receipt_events(id) ON DELETE CASCADE,
            actor_user_id INTEGER NOT NULL REFERENCES users(id),
            action TEXT NOT NULL CHECK (action IN ('TRACKING_UPDATE')),
            previous_tracking_no TEXT,
            new_tracking_no TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    raw.execute("CREATE INDEX idx_receipt_change_events_receipt ON receipt_change_events(receipt_id, id DESC)")
    receipt_common = (
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "v8-device",
        "EMS123456789",
        "ems123456789",
        "ems123456789",
        "/tmp/legacy.jpg",
        "legacy.jpg",
        "image/jpeg",
        "a" * 64,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
    )
    raw.execute(
        """
        INSERT INTO receipt_events(
            id, client_event_id, operator_user_id, event_type, input_method,
            captured_at, server_received_at, device_id, barcode_candidate,
            tracking_no, tracking_no_normalized, duplicate_of_receipt_id,
            evidence_status, photo_storage_path, photo_original_name,
            photo_content_type, photo_sha256, photo_size, created_at, updated_at
        ) VALUES
            (1, 'legacy-photo-0001', 1, 'RECEIVE', 'PHOTO_CAPTURE', ?, ?, ?, ?, ?, ?, NULL,
             'READY', ?, ?, ?, ?, 100, ?, ?),
            (2, 'legacy-photo-0002', 1, 'RECEIVE', 'PHOTO_CAPTURE', ?, ?, ?, ?, ?, ?, 1,
             'READY', ?, ?, ?, ?, 101, ?, ?)
        """,
        receipt_common + receipt_common,
    )
    raw.execute(
        """
        INSERT INTO receipt_change_events(
            id, client_event_id, receipt_id, actor_user_id, action,
            previous_tracking_no, new_tracking_no, created_at
        ) VALUES (1, 'legacy-change-0001', 2, 1, 'TRACKING_UPDATE', 'old',
                  'EMS123456789', '2026-08-01T00:01:00.000Z')
        """
    )
    raw.execute(
        """
        CREATE TABLE schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
        )
        """
    )
    for version, name in (
        (1, "initial_schema"),
        (2, "item_identity"),
        (3, "package_links_order_level"),
        (4, "ali1688_sync_state"),
        (5, "responsibility_and_manual_arrival"),
        (6, "user_management_audit"),
        (7, "platform_account_sync_state"),
        (8, "normalize_pdd_account_source"),
    ):
        raw.execute(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
            (version, name, "2026-08-01T00:00:00.000Z"),
        )
    raw.commit()
    raw.close()

    Database(path).initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-30T00:00:00.000Z",
    )

    with Database(path).connect() as connection:
        receipts = connection.execute(
            "SELECT id, duplicate_of_receipt_id, input_method FROM receipt_events ORDER BY id"
        ).fetchall()
        assert [(row["id"], row["duplicate_of_receipt_id"], row["input_method"]) for row in receipts] == [
            (1, None, "PHOTO_CAPTURE"),
            (2, 1, "PHOTO_CAPTURE"),
        ]
        change = connection.execute(
            "SELECT receipt_id, new_tracking_no FROM receipt_change_events"
        ).fetchone()
        assert (change["receipt_id"], change["new_tracking_no"]) == (2, "EMS123456789")
        inserted = connection.execute(
            """
            INSERT INTO receipt_events(
                client_event_id, operator_user_id, event_type, input_method,
                captured_at, server_received_at, device_id, evidence_status,
                photo_storage_path, photo_content_type, photo_sha256, photo_size,
                created_at, updated_at
            ) VALUES ('gallery-after-migration', 1, 'RECEIVE', 'PHOTO_LIBRARY',
                      '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z', 'new-device',
                      'READY', '/tmp/new.jpg', 'image/jpeg', ?, 100,
                      '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z')
            """,
            ("b" * 64,),
        )
        assert inserted.lastrowid == 3
        connection.commit()
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_failed_migration_leaves_no_partial_schema(tmp_path) -> None:
    path = tmp_path / "fail" / "arrival.db"
    path.parent.mkdir(parents=True)

    def bad_migration(connection: sqlite3.Connection) -> None:
        connection.execute("CREATE TABLE half_baked_table (id INTEGER PRIMARY KEY)")
        raise RuntimeError("boom")

    import app.database as database_module

    original = database_module.MIGRATIONS
    database_module.MIGRATIONS = original + (
        Migration(version=3, name="bad_migration", apply=bad_migration),
    )
    try:
        database = Database(path)
        try:
            database.initialize(
                bootstrap_username="admin",
                bootstrap_password="correct horse battery staple",
                bootstrap_display_name="管理员",
                session_secret="test-session-secret-that-is-long-enough",
                sync_worker_tokens=(),
                now="2026-08-13T00:00:00.000Z",
            )
            raise AssertionError("initialize should have raised")
        except RuntimeError:
            pass
    finally:
        database_module.MIGRATIONS = original

    with database.connect() as connection:
        applied = {row["name"] for row in connection.execute("SELECT name FROM schema_migrations")}
        assert "bad_migration" not in applied
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert "half_baked_table" not in tables
        assert "users" in tables
        assert "receipt_events" in tables


def test_responsibility_migration_upgrades_version_four_database(tmp_path) -> None:
    path = tmp_path / "responsibility-v4" / "arrival.db"
    path.parent.mkdir(parents=True)
    raw = sqlite3.connect(path)
    raw.row_factory = sqlite3.Row
    _exec_script_in_tx(raw, SCHEMA)
    raw.execute("DROP TABLE order_arrival_events")
    raw.execute("DROP TABLE order_arrival_overrides")
    raw.execute("DROP TABLE receipt_change_events")
    raw.execute(
        """
        CREATE TABLE schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
        )
        """
    )
    for version, name in (
        (1, "initial_schema"),
        (2, "item_identity"),
        (3, "package_links_order_level"),
        (4, "ali1688_sync_state"),
    ):
        raw.execute(
            """
            INSERT INTO schema_migrations(version, name, applied_at)
            VALUES (?, ?, '2026-08-01T00:00:00.000Z')
            """,
            (version, name),
        )
    raw.commit()
    raw.close()

    Database(path).initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-30T00:00:00.000Z",
    )

    database = Database(path)
    with database.connect() as connection:
        tables = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert {
            "order_arrival_overrides",
            "order_arrival_events",
            "receipt_change_events",
        } <= tables
        migrations = connection.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version"
        ).fetchall()
        assert [(row["version"], row["name"]) for row in migrations][-4:] == [
            (8, "normalize_pdd_account_source"),
            (9, "manual_orders"),
            (10, "photo_library_input"),
            (11, "manual_order_batches"),
        ]


def test_user_audit_migration_upgrades_version_five_database(tmp_path) -> None:
    path = tmp_path / "user-audit-v5" / "arrival.db"
    path.parent.mkdir(parents=True)
    raw = sqlite3.connect(path)
    raw.row_factory = sqlite3.Row
    _exec_script_in_tx(raw, SCHEMA)
    raw.execute("DROP TABLE user_management_events")
    raw.execute(
        """
        CREATE TABLE schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
        )
        """
    )
    for version, name in (
        (1, "initial_schema"),
        (2, "item_identity"),
        (3, "package_links_order_level"),
        (4, "ali1688_sync_state"),
        (5, "responsibility_and_manual_arrival"),
    ):
        raw.execute(
            """
            INSERT INTO schema_migrations(version, name, applied_at)
            VALUES (?, ?, '2026-08-01T00:00:00.000Z')
            """,
            (version, name),
        )
    raw.commit()
    raw.close()

    Database(path).initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-30T00:00:00.000Z",
    )

    with Database(path).connect() as connection:
        assert connection.execute(
            """
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'user_management_events'
            """
        ).fetchone() is not None
        last_migration = connection.execute(
            """
            SELECT version, name FROM schema_migrations
            ORDER BY version DESC LIMIT 1
            """
        ).fetchone()
        assert (last_migration["version"], last_migration["name"]) == (
            11,
            "manual_order_batches",
        )
