from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.sync_ingest import ingest_sync_batch


def batch_payload(batch_id: str = "b0000000-0000-4000-8000-000000000001", **overrides) -> dict:
    payload = {
        "schema_version": 1,
        "batch_id": batch_id,
        "worker_id": "win-arrival-01",
        "platform": "pdd",
        "platform_account_key": "pdd-main",
        "started_at": "2026-08-13T02:00:00.000Z",
        "finished_at": "2026-08-13T02:01:00.000Z",
        "cursor_before": None,
        "cursor_after": None,
        "mode": "commit",
        "orders": [
            {
                "platform_order_id": "260813-0001",
                "ordered_at": "2026-08-12T10:30:00.000Z",
                "status": "SHIPPED",
                "shop_name": "测试店铺",
                "items": [
                    {
                        "item_key": "item-1",
                        "title": "示例商品",
                        "sku_text": "规格:标准",
                        "quantity": 2,
                        "unit_price": "12.50",
                    }
                ],
                "packages": [
                    {"courier": "顺丰速运", "tracking_no": "SF515407643541", "status": "SHIPPED"}
                ],
                "observed_at": "2026-08-13T02:00:10.000Z",
            }
        ],
    }
    payload.update(overrides)
    return payload


def test_sync_batch_requires_worker_token(client: TestClient) -> None:
    assert client.post("/api/sync/v1/batches", json=batch_payload()).status_code == 401
    assert (
        client.post(
            "/api/sync/v1/batches",
            json=batch_payload(),
            headers={"Authorization": "Bearer wrong-token"},
        ).status_code
        == 401
    )


def test_sync_batch_rejects_unknown_and_sensitive_fields(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload()
    payload["cookie"] = "session=secret"
    payload["orders"][0]["receiver_phone"] = "13800138000"
    payload["orders"][0]["items"][0]["password"] = "hunter2"
    response = client.post("/api/sync/v1/batches", json=payload, headers=sync_headers)
    assert response.status_code == 422


def test_sync_batch_accepts_and_ingests(
    client: TestClient, sync_headers: dict[str, str], settings
) -> None:
    response = client.post("/api/sync/v1/batches", json=batch_payload(), headers=sync_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["batch_id"] == "b0000000-0000-4000-8000-000000000001"
    assert body["created"] == 1
    assert body["updated"] == 0
    assert body["skipped"] == 0
    assert body["errors"] == []
    assert body["cursor_accepted"] is True

    database = client.app.state.database
    with database.connect() as connection:
        account = connection.execute(
            "SELECT id FROM platform_accounts WHERE platform = 'pdd' AND account_key = 'pdd-main'"
        ).fetchone()
        assert account is not None
        orders = connection.execute("SELECT * FROM purchase_orders").fetchall()
        assert len(orders) == 1
        assert orders[0]["platform_order_id"] == "260813-0001"
        assert orders[0]["order_status"] == "SHIPPED"
        assert orders[0]["shop_name"] == "测试店铺"
        items = connection.execute("SELECT * FROM order_items").fetchall()
        assert len(items) == 1
        assert items[0]["quantity"] == "2"
        packages = connection.execute("SELECT * FROM packages").fetchall()
        assert len(packages) == 1
        assert packages[0]["tracking_no_normalized"] == "SF515407643541"
        links = connection.execute("SELECT * FROM package_order_links").fetchall()
        assert len(links) == 1
        batches = connection.execute("SELECT * FROM sync_batches").fetchall()
        assert len(batches) == 1
        assert batches[0]["status"] == "OK"
        assert batches[0]["token_digest"] != "test-sync-worker-token-0001"


def test_sync_batch_replay_returns_original_result(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = client.post("/api/sync/v1/batches", json=batch_payload(), headers=sync_headers)
    assert first.status_code == 200
    second = client.post("/api/sync/v1/batches", json=batch_payload(), headers=sync_headers)
    assert second.status_code == 200
    assert second.json()["created"] == first.json()["created"]
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 1
        assert connection.execute("SELECT COUNT(*) AS c FROM sync_batches").fetchone()["c"] == 1


def test_sync_batch_id_conflict_returns_409(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    assert client.post("/api/sync/v1/batches", json=batch_payload(), headers=sync_headers).status_code == 200
    changed = batch_payload()
    changed["orders"][0]["platform_order_id"] = "260813-0002"
    response = client.post("/api/sync/v1/batches", json=changed, headers=sync_headers)
    assert response.status_code == 409


def test_sync_batch_rejects_bad_fields(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    cases = [
        batch_payload(schema_version=2),
        batch_payload(mode="dry_run"),
        batch_payload(platform="taobao"),
        batch_payload(orders=[]),
        batch_payload(orders=[batch_payload()["orders"][0]] * 101),
        batch_payload(batch_id=""),
    ]
    for payload in cases:
        response = client.post("/api/sync/v1/batches", json=payload, headers=sync_headers)
        assert response.status_code == 422, json.dumps(payload)[:200]

    bad_orders = [
        {**batch_payload()["orders"][0], "platform_order_id": ""},
        {**batch_payload()["orders"][0], "status": "MYSTERY"},
        {**batch_payload()["orders"][0], "items": []},
        {**batch_payload()["orders"][0], "observed_at": "2026-08-13T02:00:10"},
        {**batch_payload()["orders"][0], "packages": [{"courier": None, "tracking_no": "---"}]},
        {
            **batch_payload()["orders"][0],
            "items": [{"item_key": None, "title": "x", "sku_text": None, "quantity": 0, "unit_price": None}],
        },
    ]
    for order in bad_orders:
        payload = batch_payload(batch_id="b0000000-0000-4000-8000-000000000009")
        payload["orders"] = [order]
        response = client.post("/api/sync/v1/batches", json=payload, headers=sync_headers)
        assert response.status_code == 422, json.dumps(order)[:200]


def test_sync_batch_size_limit(client: TestClient, settings, sync_headers: dict[str, str]) -> None:
    tiny = replace(settings, sync_max_batch_bytes=4096)
    with TestClient(create_app(tiny)) as limited:
        big = batch_payload("b-big-0001")
        big["orders"] = [
            {
                "platform_order_id": f"260813-{index:04d}",
                "ordered_at": None,
                "status": "UNKNOWN",
                "shop_name": "店铺" * 40,
                "items": [
                    {
                        "item_key": None,
                        "title": "商品标题" * 60,
                        "sku_text": None,
                        "quantity": 1,
                        "unit_price": None,
                    }
                ],
                "packages": [],
                "observed_at": "2026-08-13T02:00:10.000Z",
            }
            for index in range(100)
        ]
        response = limited.post(
            "/api/sync/v1/batches",
            json=big,
            headers={"Authorization": "Bearer test-sync-worker-token-0001"},
        )
        assert response.status_code == 413


def test_sync_batch_rate_limit(client: TestClient, settings) -> None:
    limited = replace(settings, sync_rate_limit_per_hour=2)
    with TestClient(create_app(limited)) as test_client:
        headers = {"Authorization": "Bearer test-sync-worker-token-0001"}
        first = test_client.post(
            "/api/sync/v1/batches", json=batch_payload("b-rate-0001"), headers=headers
        )
        assert first.status_code == 200
        second = test_client.post(
            "/api/sync/v1/batches", json=batch_payload("b-rate-0002"), headers=headers
        )
        assert second.status_code == 200
        third = test_client.post(
            "/api/sync/v1/batches", json=batch_payload("b-rate-0003"), headers=headers
        )
        assert third.status_code == 429
        assert "Retry-After" in third.headers


def test_worker_token_cannot_access_admin_endpoints(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    assert client.get("/api/receipts", headers=sync_headers).status_code == 401
    assert client.get("/api/auth/me", headers=sync_headers).status_code == 401


def test_sync_batch_unavailable_without_tokens(client: TestClient, settings) -> None:
    unconfigured = replace(settings, sync_worker_tokens=())
    with TestClient(create_app(unconfigured)) as test_client:
        response = test_client.post(
            "/api/sync/v1/batches",
            json=batch_payload(),
            headers={"Authorization": "Bearer anything-at-all-0001"},
        )
        assert response.status_code == 503


def test_ingest_rolls_back_on_failure(client: TestClient, sync_headers: dict[str, str]) -> None:
    with client.app.state.database.connect() as connection:
        database_path = Path(client.app.state.database.path)
    raw = sqlite3.connect(database_path)
    raw.row_factory = sqlite3.Row

    class ExplodingConnection:
        def __init__(self, wrapped: sqlite3.Connection):
            self._wrapped = wrapped
            self._link_writes = 0

        def execute(self, sql: str, params=()):
            if "package_order_links" in sql and "INSERT" in sql:
                self._link_writes += 1
                if self._link_writes >= 2:
                    raise sqlite3.OperationalError("injected failure")
            return self._wrapped.execute(sql, params)

        def commit(self):
            return self._wrapped.commit()

        def rollback(self):
            return self._wrapped.rollback()

    from app.sync_ingest import SyncBatchIn, canonical_payload_digest

    payload = SyncBatchIn.model_validate(
        {
            **batch_payload("b-rollback-0001"),
            "orders": batch_payload()["orders"] * 2,
        }
    )
    digest = canonical_payload_digest(
        json.dumps(
            json.loads(json.dumps(batch_payload("b-rollback-0001"))),
            separators=(",", ":"),
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
    )
    proxy = ExplodingConnection(raw)
    try:
        ingest_sync_batch(proxy, payload, digest, "test-digest", "2026-08-13T02:00:00.000Z")
        raise AssertionError("expected injected failure")
    except sqlite3.OperationalError:
        pass

    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 0
        assert connection.execute("SELECT COUNT(*) AS c FROM packages").fetchone()["c"] == 0
        assert connection.execute("SELECT COUNT(*) AS c FROM order_items").fetchone()["c"] == 0
        failed = connection.execute(
            "SELECT status, error_code FROM sync_batches WHERE batch_id = 'b-rollback-0001'"
        ).fetchone()
        assert failed is not None
        assert failed["status"] == "ERROR"
        assert failed["error_code"] == "INGEST_FAILED"


def test_repeat_ingest_is_idempotent(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    first = client.post(
        "/api/sync/v1/batches", json=batch_payload("b-repeat-0001"), headers=sync_headers
    )
    assert first.status_code == 200
    assert first.json()["created"] == 1
    second = client.post(
        "/api/sync/v1/batches", json=batch_payload("b-repeat-0002"), headers=sync_headers
    )
    assert second.status_code == 200
    assert second.json()["skipped"] == 1
    assert second.json()["created"] == 0
    with client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 1
        assert connection.execute("SELECT COUNT(*) AS c FROM order_items").fetchone()["c"] == 1
        assert connection.execute("SELECT COUNT(*) AS c FROM packages").fetchone()["c"] == 1
        assert connection.execute("SELECT COUNT(*) AS c FROM package_order_links").fetchone()["c"] == 1


def test_multi_package_and_cross_platform_links(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = batch_payload("b-links-0001")
    payload["orders"] = [
        {
            "platform_order_id": "order-A",
            "ordered_at": None,
            "status": "UNKNOWN",
            "shop_name": None,
            "items": [{"item_key": None, "title": "A", "sku_text": None, "quantity": 1, "unit_price": None}],
            "packages": [
                {"courier": None, "tracking_no": "ZTO-1", "status": None},
                {"courier": None, "tracking_no": "ZTO-2", "status": None},
            ],
            "observed_at": "2026-08-13T02:00:10.000Z",
        },
        {
            "platform_order_id": "order-B",
            "ordered_at": None,
            "status": "UNKNOWN",
            "shop_name": None,
            "items": [{"item_key": None, "title": "B", "sku_text": None, "quantity": 1, "unit_price": None}],
            "packages": [{"courier": None, "tracking_no": "zto-1", "status": None}],
            "observed_at": "2026-08-13T02:00:10.000Z",
        },
    ]
    assert client.post("/api/sync/v1/batches", json=payload, headers=sync_headers).status_code == 200

    platform2 = batch_payload("b-links-0002", platform="1688", platform_account_key="1688-main")
    platform2["orders"] = [
        {
            "platform_order_id": "order-C",
            "ordered_at": None,
            "status": "PAID",
            "shop_name": None,
            "items": [{"item_key": None, "title": "C", "sku_text": None, "quantity": 1, "unit_price": None}],
            "packages": [{"courier": None, "tracking_no": "ZTO 1", "status": None}],
            "observed_at": "2026-08-13T02:00:10.000Z",
        }
    ]
    assert client.post("/api/sync/v1/batches", json=platform2, headers=sync_headers).status_code == 200

    with client.app.state.database.connect() as connection:
        package_rows = connection.execute(
            "SELECT id, tracking_no_normalized FROM packages ORDER BY id"
        ).fetchall()
        assert len(package_rows) == 2
        zto1_id = next(row["id"] for row in package_rows if row["tracking_no_normalized"] == "ZTO1")
        links = connection.execute(
            "SELECT COUNT(*) AS c FROM package_order_links WHERE package_id = ?", (zto1_id,)
        ).fetchone()["c"]
        assert links == 3


def test_sync_endpoint_ignores_trusted_lan_mode(client: TestClient) -> None:
    trusted_headers = {
        "Host": "192.168.1.5",
        "X-Real-IP": "192.168.1.20",
        "X-Arrival-Client": "wechat-h5",
        "Authorization": "Bearer test-sync-worker-token-0001",
    }
    response = client.post("/api/sync/v1/batches", json=batch_payload(), headers=trusted_headers)
    assert response.status_code == 200
