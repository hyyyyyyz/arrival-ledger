from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_FILE = ROOT / "sync-agent" / "tests" / "fixtures" / "batch_contract.json"


def test_backend_accepts_the_ts_client_golden_contract(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = json.loads(CONTRACT_FILE.read_text(encoding="utf-8"))
    response = client.post(
        "/api/sync/v1/batches",
        json=payload,
        headers={**sync_headers, "Idempotency-Key": payload["batch_id"]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["batch_id"] == "b0000000-0000-4000-8000-00000000dead"
    assert body["created"] == 2
    assert body["updated"] == 0
    assert body["skipped"] == 0
    assert body["cursor_accepted"] is True

    database = client.app.state.database
    with database.connect() as connection:
        orders = connection.execute(
            "SELECT platform_order_id, order_status FROM purchase_orders ORDER BY id"
        ).fetchall()
        assert [row["platform_order_id"] for row in orders] == ["260813-0001", "260813-0002"]
        assert [row["order_status"] for row in orders] == ["SHIPPED", "CANCELLED"]
        packages = connection.execute(
            "SELECT tracking_no_normalized FROM packages"
        ).fetchall()
        assert [row["tracking_no_normalized"] for row in packages] == ["SF1234567890000"]
        items = connection.execute(
            "SELECT title, quantity FROM order_items ORDER BY id"
        ).fetchall()
        assert [row["quantity"] for row in items] == ["2", "1"]
        links = connection.execute(
            """
            SELECT COUNT(*) AS c FROM package_order_links
            JOIN purchase_orders ON purchase_orders.id = package_order_links.order_id
            WHERE purchase_orders.platform_order_id = '260813-0001'
            """
        ).fetchone()
        assert links["c"] == 1
        batches = connection.execute("SELECT status FROM sync_batches").fetchall()
        assert [row["status"] for row in batches] == ["OK"]


def test_backend_replays_the_golden_contract_idempotently(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    payload = json.loads(CONTRACT_FILE.read_text(encoding="utf-8"))
    first = client.post(
        "/api/sync/v1/batches",
        json=payload,
        headers={**sync_headers, "Idempotency-Key": payload["batch_id"]},
    )
    second = client.post(
        "/api/sync/v1/batches",
        json=payload,
        headers={**sync_headers, "Idempotency-Key": payload["batch_id"]},
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json() == first.json()
