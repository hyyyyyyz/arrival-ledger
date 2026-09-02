from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from test_sync_api import batch_payload, post_batch


ADMIN_PASSWORD = "correct horse battery staple"
RECEIVER_PASSWORD = "Receiver-Strong-2026!"


def _login(client: TestClient, username: str, password: str) -> None:
    client.post("/api/auth/logout")
    response = client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )
    assert response.status_code == 200


def _create_receiver(client: TestClient, username: str = "receiver.one") -> dict:
    response = client.post(
        "/api/users",
        json={
            "username": username,
            "display_name": "收货员一号",
            "password": RECEIVER_PASSWORD,
            "role": "RECEIVER",
        },
    )
    assert response.status_code == 201
    return response.json()


def _upload_receipt(
    client: TestClient,
    *,
    event_id: str,
    tracking_no: str,
    photo: bytes,
) -> dict:
    response = client.post(
        "/api/receipts",
        data={
            "client_event_id": event_id,
            "captured_at": "2026-08-30T10:20:30+08:00",
            "device_id": "manual-arrival-test-device",
            "tracking_no": tracking_no,
            "input_method": "PHOTO_CAPTURE",
        },
        files={"photo": (f"{event_id}.jpg", photo, "image/jpeg")},
    )
    assert response.status_code == 201
    return response.json()["receipt"]


def _seed_order(
    client: TestClient,
    sync_headers: dict[str, str],
    *,
    order_id: str = "MANUAL-ORDER-001",
    tracking_no: str | None = "MANUAL-TRACKING-001",
) -> dict:
    payload = batch_payload(f"batch-{order_id.lower()}")
    payload["orders"][0]["platform_order_id"] = order_id
    payload["orders"][0]["packages"] = (
        [
            {
                "courier": "顺丰速运",
                "tracking_no": tracking_no,
                "status": "SHIPPED",
            }
        ]
        if tracking_no is not None
        else []
    )
    assert post_batch(client, payload, sync_headers).status_code == 200
    return client.get("/api/orders", params={"query": order_id}).json()["items"][0]


def _change(
    client: TestClient,
    order_id: str,
    *,
    status: str,
    revision: int,
    event_id: str,
    reason: str | None = None,
):
    payload: dict[str, object] = {
        "status": status,
        "expected_revision": revision,
        "client_event_id": event_id,
    }
    if reason is not None:
        payload["reason"] = reason
    return client.patch(f"/api/orders/{order_id}/arrival-status", json=payload)


def test_manual_arrival_requires_authentication(client: TestClient) -> None:
    response = _change(
        client,
        "1",
        status="RECEIVED",
        revision=0,
        event_id="manual-unauthenticated-0001",
    )
    assert response.status_code == 401
    assert client.get("/api/orders/1/arrival-history").status_code == 401


def test_third_party_order_is_idempotent_and_visible_in_order_list(
    authenticated_client: TestClient,
) -> None:
    payload = {
        "client_event_id": "third-party-create-0001",
        "tracking_no": "YT-OTHER-1234",
        "product_name": "甲方采购的样品",
        "courier": "圆通速递",
        "remark": "无需平台同步",
    }
    created = authenticated_client.post("/api/manual-orders", json=payload)
    assert created.status_code == 201
    assert created.json()["created"] is True
    replay = authenticated_client.post("/api/manual-orders", json=payload)
    assert replay.status_code == 201
    assert replay.json()["idempotent_replay"] is True
    for field, value in (
        ("tracking_no", "YT-OTHER-9999"),
        ("product_name", "被篡改的商品"),
        ("courier", "中通快递"),
        ("remark", "被篡改的备注"),
    ):
        conflicting_replay = authenticated_client.post(
            "/api/manual-orders",
            json={**payload, field: value},
        )
        assert conflicting_replay.status_code == 409
    duplicate = authenticated_client.post(
        "/api/manual-orders", json={**payload, "client_event_id": "third-party-create-0002"}
    )
    assert duplicate.status_code == 409
    orders = authenticated_client.get("/api/orders", params={"platform": "other"})
    assert orders.status_code == 200
    order = orders.json()["items"][0]
    assert order["platform"] == "other"
    assert order["source"] == "THIRD_PARTY_MANUAL"
    assert order["items"][0]["title"] == payload["product_name"]
    assert order["packages"][0]["tracking_no"] == payload["tracking_no"]
    assert order["manual_created_by"]["username"] == "admin"
    assert order["manual_remark"] == payload["remark"]
    stats = authenticated_client.get("/api/dashboard/stats").json()
    assert stats["total_orders"] == 1
    assert stats["account_count"] == 0


def test_third_party_order_rejects_tracking_collision_with_platform_order(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    _seed_order(authenticated_client, sync_headers, order_id="REAL-ORDER-001", tracking_no="SHARED-REAL-001")
    response = authenticated_client.post(
        "/api/manual-orders",
        json={
            "client_event_id": "third-party-collision-0001",
            "tracking_no": "shared real 001",
            "product_name": "不应创建",
        },
    )
    assert response.status_code == 409


@pytest.mark.parametrize(
    "tracking_no",
    [
        "9.818907591847E+12",
        "9.818907591847 E+12",
        "9818907591847.0",
        "9818907591847,0",
        "2026-09-02",
        "02/09/2026",
        "SF12345678/YT87654321",
        "SF12345678\nYT87654321",
        "运单号SF12345678",
    ],
)
def test_single_manual_order_rejects_unsafe_tracking_number_formats(
    authenticated_client: TestClient,
    tracking_no: str,
) -> None:
    response = authenticated_client.post(
        "/api/manual-orders",
        json={
            "client_event_id": f"single-coercion-{hashlib.sha256(tracking_no.encode()).hexdigest()[:16]}",
            "tracking_no": tracking_no,
            "product_name": "不应创建",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]


def test_single_manual_order_rejects_implausible_normalized_tracking_number(
    authenticated_client: TestClient,
) -> None:
    for index, tracking_no in enumerate(("1234567", "ABCDEFGH"), start=1):
        response = authenticated_client.post(
            "/api/manual-orders",
            json={
                "client_event_id": f"single-invalid-{index:04d}",
                "tracking_no": tracking_no,
                "product_name": "不应创建",
            },
        )
        assert response.status_code == 422


def test_manual_order_batch_requires_authentication(client: TestClient) -> None:
    response = client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": "manual-batch-unauthenticated-0001",
            "tracking_text": "YT-UNAUTH-001",
        },
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "tracking_text",
    [
        "9818907591847,0",
        "SF12345678; 9818907591847，0\nYT87654321",
    ],
)
def test_manual_order_batch_tracking_text_rejects_truncated_decimal_pair(
    authenticated_client: TestClient,
    tracking_text: str,
) -> None:
    response = authenticated_client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": f"batch-decimal-{hashlib.sha256(tracking_text.encode()).hexdigest()[:16]}",
            "tracking_text": tracking_text,
        },
    )

    assert response.status_code == 422
    assert authenticated_client.get("/api/orders", params={"platform": "other"}).json()["total"] == 0


def test_manual_order_batch_tracking_text_accepts_two_long_numeric_numbers(
    authenticated_client: TestClient,
) -> None:
    response = authenticated_client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": "batch-two-long-numeric-0001",
            "tracking_text": "9818907591847,9818907591848",
        },
    )

    assert response.status_code == 200
    assert response.json()["created_count"] == 2


def test_manual_order_batch_enforces_body_limit(
    authenticated_client: TestClient,
) -> None:
    oversized = authenticated_client.post(
        "/api/manual-orders/batch",
        content=(
            '{"client_batch_id":"manual-batch-too-large-0001",'
            '"tracking_text":"' + ("A" * (512 * 1024)) + '"}'
        ).encode(),
        headers={"Content-Type": "application/json"},
    )
    assert oversized.status_code == 413
    assert "512 KiB" in oversized.json()["detail"]


def test_manual_order_batch_parses_deduplicates_validates_and_replays(
    authenticated_client: TestClient,
) -> None:
    payload = {
        "client_batch_id": "manual-batch-mixed-0001",
        "tracking_text": " YT-000001，yt 000001\nSF-000002;；",
        "courier": "圆通速递",
        "rows": [
            {
                "row_number": 2,
                "tracking_no": "JD-000003",
                "product_name": "逐行商品",
                "courier": "京东物流",
            },
            {"row_number": 3, "tracking_no": "  "},
            {"row_number": 4, "tracking_no": "!!!"},
            {"row_number": 5, "tracking_no": 12345678},
            {"row_number": 6, "tracking_no": 12.0},
            {"row_number": 7, "tracking_no": 9_007_199_254_740_992},
            {
                "row_number": 8,
                "tracking_no": "PRODUCT-0008",
                "product_name": "商" * 257,
            },
        ],
    }
    response = authenticated_client.post("/api/manual-orders/batch", json=payload)
    assert response.status_code == 200
    body = response.json()
    assert body["idempotent_replay"] is False
    assert {
        key: body[key]
        for key in (
            "total_count",
            "unique_count",
            "created_count",
            "idempotent_count",
            "duplicate_count",
            "failed_count",
        )
    } == {
        "total_count": 10,
        "unique_count": 3,
        "created_count": 3,
        "idempotent_count": 0,
        "duplicate_count": 1,
        "failed_count": 6,
    }
    assert [item["status"] for item in body["items"]] == [
        "CREATED",
        "DUPLICATE_INPUT",
        "CREATED",
        "CREATED",
        "FAILED",
        "FAILED",
        "FAILED",
        "FAILED",
        "FAILED",
        "FAILED",
    ]
    failures = {
        item["row_number"]: item["error_code"]
        for item in body["items"]
        if item["status"] == "FAILED"
    }
    assert failures == {
        3: "MISSING_TRACKING",
        4: "INVALID_TRACKING",
        5: "INVALID_FIELD_TYPE",
        6: "INVALID_FIELD_TYPE",
        7: "INVALID_FIELD_TYPE",
        8: "PRODUCT_NAME_TOO_LONG",
    }
    created = [item for item in body["items"] if item["status"] == "CREATED"]
    assert {item["tracking_no_normalized"] for item in created} == {
        "YT000001",
        "SF000002",
        "JD000003",
    }
    assert next(item for item in created if item["tracking_no_normalized"] == "YT000001")[
        "product_name"
    ] == "未填写商品名称"

    orders = authenticated_client.get("/api/orders", params={"platform": "other", "limit": 100})
    assert orders.status_code == 200
    assert orders.json()["total"] == 3
    assert all(
        order["manual_created_by"]["username"] == "admin"
        for order in orders.json()["items"]
    )
    with authenticated_client.app.state.database.connect() as connection:
        batch = connection.execute(
            """
            SELECT b.client_batch_id, b.item_count, u.username
            FROM manual_order_batches b
            JOIN users u ON u.id = b.actor_user_id
            WHERE b.client_batch_id = ?
            """,
            (payload["client_batch_id"],),
        ).fetchone()
        assert dict(batch) == {
            "client_batch_id": payload["client_batch_id"],
            "item_count": 10,
            "username": "admin",
        }

    replay = authenticated_client.post("/api/manual-orders/batch", json=payload)
    assert replay.status_code == 200
    replay_body = replay.json()
    assert replay_body["idempotent_replay"] is True
    assert replay_body["created_count"] == 0
    assert replay_body["idempotent_count"] == 3
    assert replay_body["duplicate_count"] == 1
    assert replay_body["failed_count"] == 6
    assert authenticated_client.get(
        "/api/orders", params={"platform": "other"}
    ).json()["total"] == 3

    changed_replay = authenticated_client.post(
        "/api/manual-orders/batch",
        json={**payload, "product_name": "不能复用批次号"},
    )
    assert changed_replay.status_code == 409


def test_manual_order_batch_rejects_unsafe_or_implausible_tracking_values(
    authenticated_client: TestClient,
) -> None:
    response = authenticated_client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": "manual-batch-tracking-validation-0001",
            "rows": [
                {"row_number": 2, "tracking_no": "1234567"},
                {"row_number": 3, "tracking_no": "ABCDEFGH"},
                {"row_number": 4, "tracking_no": ("A" * 32) + "1"},
                {"row_number": 5, "tracking_no": "1" * 129},
                {"row_number": 6, "tracking_no": 9_007_199_254_740_991},
                {"row_number": 7, "tracking_no": 9_007_199_254_740_992},
                {"row_number": 8, "tracking_no": 12345678.0},
                {"row_number": 9, "tracking_no": True},
                {"row_number": 10, "tracking_no": None},
                {"row_number": 11, "tracking_no": {"value": "SF12345678"}},
                {"row_number": 12, "tracking_no": "1.23456789E+12"},
                {"row_number": 13, "tracking_no": "2026-09-02"},
                {"row_number": 14, "tracking_no": "9818907591847.0"},
                {"row_number": 15, "tracking_no": "9818907591847,0"},
                {"row_number": 16, "tracking_no": "SF12345678/YT87654321"},
                {"row_number": 17, "tracking_no": "SF12345678\nYT87654321"},
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created_count"] == 0
    assert body["failed_count"] == 16
    assert [item["error_code"] for item in body["items"]] == [
        "INVALID_TRACKING",
        "INVALID_TRACKING",
        "INVALID_TRACKING",
        "TRACKING_TOO_LONG",
        "INVALID_FIELD_TYPE",
        "INVALID_FIELD_TYPE",
        "INVALID_FIELD_TYPE",
        "INVALID_FIELD_TYPE",
        "INVALID_FIELD_TYPE",
        "INVALID_FIELD_TYPE",
        "INVALID_TRACKING",
        "INVALID_TRACKING",
        "INVALID_TRACKING",
        "INVALID_TRACKING",
        "INVALID_TRACKING",
        "INVALID_TRACKING",
    ]


def test_manual_order_batch_rejects_spreadsheet_number_and_date_coercions(
    authenticated_client: TestClient,
) -> None:
    suspicious = [
        "9.81 E+12",
        "2026-09-02",
        "2026.09.02",
        "2026/09/02",
        "09/02/2026",
        "02-09-2026",
        "2026年9月2日",
        "2026 年 9 月 2 日",
    ]
    response = authenticated_client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": "manual-batch-spreadsheet-coercion-0001",
            "rows": [
                {"row_number": index + 2, "tracking_no": tracking_no}
                for index, tracking_no in enumerate([*suspicious, "20260902"])
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created_count"] == 1
    assert body["failed_count"] == len(suspicious)
    assert [item["error_code"] for item in body["items"]] == [
        *(["INVALID_TRACKING"] * len(suspicious)),
        None,
    ]
    assert body["items"][-1]["tracking_no_normalized"] == "20260902"


def test_manual_order_batch_accepts_exactly_500_rows_and_replays_atomically(
    authenticated_client: TestClient,
) -> None:
    payload = {
        "client_batch_id": "manual-batch-exact-limit-0001",
        "rows": [
            {"row_number": index + 2, "tracking_no": f"MAX{index:08d}"}
            for index in range(500)
        ],
    }
    created = authenticated_client.post("/api/manual-orders/batch", json=payload)
    assert created.status_code == 200
    assert created.json()["total_count"] == 500
    assert created.json()["created_count"] == 500
    assert created.json()["failed_count"] == 0

    replay = authenticated_client.post("/api/manual-orders/batch", json=payload)
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["created_count"] == 0
    assert replay.json()["idempotent_count"] == 500
    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM manual_order_batches"
        ).fetchone()["count"] == 1
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM manual_order_events"
        ).fetchone()["count"] == 500
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM purchase_orders"
        ).fetchone()["count"] == 500


def test_concurrent_identical_manual_batches_create_only_one_copy(
    authenticated_client: TestClient,
) -> None:
    payload = {
        "client_batch_id": "manual-batch-concurrent-0001",
        "tracking_text": "RACE-BATCH-0001\nRACE-BATCH-0002\nRACE-BATCH-0003",
    }

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda _: authenticated_client.post(
                    "/api/manual-orders/batch", json=payload
                ),
                range(2),
            )
        )

    assert [response.status_code for response in responses] == [200, 200]
    assert sorted(response.json()["created_count"] for response in responses) == [0, 3]
    assert sorted(response.json()["idempotent_count"] for response in responses) == [0, 3]
    assert sorted(response.json()["idempotent_replay"] for response in responses) == [
        False,
        True,
    ]
    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM manual_order_batches"
        ).fetchone()["count"] == 1
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM manual_order_events"
        ).fetchone()["count"] == 3
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM purchase_orders"
        ).fetchone()["count"] == 3


def test_manual_order_batch_reports_platform_and_manual_conflicts_without_overwrite(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    _seed_order(
        authenticated_client,
        sync_headers,
        order_id="BATCH-PLATFORM-001",
        tracking_no="PLATFORM-COLLISION-001",
    )
    single = authenticated_client.post(
        "/api/manual-orders",
        json={
            "client_event_id": "manual-before-batch-0001",
            "tracking_no": "MANUAL-COLLISION-001",
            "product_name": "原手工商品",
        },
    )
    assert single.status_code == 201

    response = authenticated_client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": "manual-batch-conflicts-0001",
            "rows": [
                {
                    "tracking_no": "platform collision 001",
                    "product_name": "不得覆盖平台订单",
                },
                {
                    "tracking_no": "manual collision 001",
                    "product_name": "不得覆盖原手工订单",
                },
                {"tracking_no": "BATCH-GOOD-001", "product_name": "可创建商品"},
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created_count"] == 1
    assert body["failed_count"] == 2
    assert [item["error_code"] for item in body["items"][:2]] == [
        "PLATFORM_ORDER_EXISTS",
        "MANUAL_ORDER_EXISTS",
    ]
    original = authenticated_client.get(
        "/api/orders", params={"query": "MANUAL-COLLISION-001"}
    ).json()["items"][0]
    assert original["items"][0]["title"] == "原手工商品"


def test_manual_order_batch_rejects_too_many_inputs_and_cross_user_batch_reuse(
    authenticated_client: TestClient,
) -> None:
    too_many = authenticated_client.post(
        "/api/manual-orders/batch",
        json={
            "client_batch_id": "manual-batch-too-many-0001",
            "rows": [{"tracking_no": f"TRACK-{index}"} for index in range(501)],
        },
    )
    assert too_many.status_code == 422

    _create_receiver(authenticated_client)
    payload = {
        "client_batch_id": "manual-batch-owned-by-admin-0001",
        "tracking_text": "OWNED-001",
    }
    assert authenticated_client.post("/api/manual-orders/batch", json=payload).status_code == 200
    _login(authenticated_client, "receiver.one", RECEIVER_PASSWORD)
    cross_user = authenticated_client.post("/api/manual-orders/batch", json=payload)
    assert cross_user.status_code == 409
    assert "其他用户" in cross_user.json()["detail"]


def test_manual_arrival_is_audited_idempotent_and_concurrency_safe(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    order = _seed_order(authenticated_client, sync_headers)
    internal_id = order["id"]
    assert order["effective_arrival_status"] == "PENDING"
    assert order["evidence_arrival_status"] == "PENDING"
    assert order["arrival_source"] == "AUTO"
    assert order["responsible_user"] is None
    assert order["manual_revision"] == 0

    first = _change(
        authenticated_client,
        internal_id,
        status="RECEIVED",
        revision=0,
        event_id="manual-received-event-0001",
        reason="仓库人工确认",
    )
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["effective_arrival_status"] == "RECEIVED"
    assert first_body["evidence_arrival_status"] == "PENDING"
    assert first_body["arrival_source"] == "MANUAL"
    assert first_body["responsible_user"]["username"] == "admin"
    assert first_body["manual_revision"] == 1
    assert first_body["audit_event_id"] is not None
    assert first_body["idempotent_replay"] is False

    replay = _change(
        authenticated_client,
        internal_id,
        status="RECEIVED",
        revision=0,
        event_id="manual-received-event-0001",
        reason="仓库人工确认",
    )
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["audit_event_id"] == first_body["audit_event_id"]

    mismatched_revision_replay = _change(
        authenticated_client,
        internal_id,
        status="RECEIVED",
        revision=999,
        event_id="manual-received-event-0001",
        reason="仓库人工确认",
    )
    assert mismatched_revision_replay.status_code == 409

    stale = _change(
        authenticated_client,
        internal_id,
        status="PENDING",
        revision=0,
        event_id="manual-stale-event-0001",
    )
    assert stale.status_code == 409

    reused = _change(
        authenticated_client,
        internal_id,
        status="PENDING",
        revision=1,
        event_id="manual-received-event-0001",
    )
    assert reused.status_code == 409

    received = authenticated_client.get(
        "/api/orders", params={"arrival_status": "received"}
    ).json()
    pending = authenticated_client.get(
        "/api/orders", params={"arrival_status": "pending"}
    ).json()
    assert received["total"] == 1
    assert pending["total"] == 0
    stats = authenticated_client.get("/api/dashboard/stats").json()
    assert stats["received_orders"] == 1
    assert stats["pending_orders"] == 0

    second = _change(
        authenticated_client,
        internal_id,
        status="PENDING",
        revision=1,
        event_id="manual-pending-event-0002",
        reason="前次确认有误",
    )
    assert second.status_code == 200
    assert second.json()["manual_revision"] == 2
    assert second.json()["effective_arrival_status"] == "PENDING"

    superseded_replay = _change(
        authenticated_client,
        internal_id,
        status="RECEIVED",
        revision=0,
        event_id="manual-received-event-0001",
        reason="仓库人工确认",
    )
    assert superseded_replay.status_code == 409

    history = authenticated_client.get(
        f"/api/orders/{internal_id}/arrival-history"
    )
    assert history.status_code == 200
    history_body = history.json()
    assert history_body["total"] == 2
    assert [item["action"] for item in history_body["items"]] == [
        "MARK_PENDING",
        "MARK_RECEIVED",
    ]
    assert history_body["items"][0]["actor"]["username"] == "admin"
    assert history_body["items"][0]["previous_effective_status"] == "RECEIVED"
    assert history_body["items"][0]["new_effective_status"] == "PENDING"
    assert history_body["items"][0]["reason"] == "前次确认有误"

    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM order_arrival_events"
        ).fetchone()["count"] == 2


def test_manual_pending_keeps_photo_evidence_and_tracks_each_responsible_user(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
    jpeg_bytes: bytes,
) -> None:
    receiver = _create_receiver(authenticated_client)
    order = _seed_order(
        authenticated_client,
        sync_headers,
        order_id="PHOTO-THEN-MANUAL-001",
        tracking_no="PHOTO-MANUAL-TRACKING-001",
    )

    _login(authenticated_client, receiver["username"], RECEIVER_PASSWORD)
    receipt = _upload_receipt(
        authenticated_client,
        event_id="photo-responsible-event-0001",
        tracking_no="PHOTO-MANUAL-TRACKING-001",
        photo=jpeg_bytes,
    )
    assert receipt["operator"]["username"] == receiver["username"]
    assert receipt["last_modified_by"] is None

    automatic = authenticated_client.get(
        "/api/orders", params={"query": "PHOTO-THEN-MANUAL-001"}
    ).json()["items"][0]
    assert automatic["effective_arrival_status"] == "RECEIVED"
    assert automatic["evidence_arrival_status"] == "RECEIVED"
    assert automatic["arrival_source"] == "AUTO"
    assert automatic["responsible_user"]["username"] == receiver["username"]
    assert automatic["changed_at"] is not None

    _login(authenticated_client, "admin", ADMIN_PASSWORD)
    manual = _change(
        authenticated_client,
        order["id"],
        status="PENDING",
        revision=0,
        event_id="manual-over-photo-event-0001",
        reason="照片关联错单，人工撤销",
    )
    assert manual.status_code == 200
    manual_body = manual.json()
    assert manual_body["effective_arrival_status"] == "PENDING"
    assert manual_body["evidence_arrival_status"] == "RECEIVED"
    assert manual_body["arrival_source"] == "MANUAL"
    assert manual_body["responsible_user"]["username"] == "admin"

    listed = authenticated_client.get(
        "/api/orders", params={"query": "PHOTO-THEN-MANUAL-001"}
    ).json()["items"][0]
    assert listed["arrival_photo_count"] == 1
    assert listed["arrived_package_count"] == 1
    assert listed["packages"][0]["arrival_status"] == "ARRIVED"
    assert listed["packages"][0]["arrived"] is True
    assert listed["effective_arrival_status"] == "PENDING"
    assert listed["evidence_arrival_status"] == "RECEIVED"

    stats = authenticated_client.get("/api/dashboard/stats").json()
    assert stats["arrival_photos"] == 1
    assert stats["matched_orders"] == 1
    assert stats["received_orders"] == 0
    assert stats["pending_orders"] == 1


def test_receiver_role_can_correct_order_and_is_recorded_as_actor(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    receiver = _create_receiver(authenticated_client, "receiver.corrector")
    order = _seed_order(
        authenticated_client,
        sync_headers,
        order_id="RECEIVER-CORRECTION-001",
        tracking_no=None,
    )
    _login(authenticated_client, receiver["username"], RECEIVER_PASSWORD)
    response = _change(
        authenticated_client,
        order["id"],
        status="RECEIVED",
        revision=0,
        event_id="receiver-correction-event-0001",
    )
    assert response.status_code == 200
    assert response.json()["responsible_user"]["username"] == "receiver.corrector"
    history = authenticated_client.get(
        f"/api/orders/{order['id']}/arrival-history"
    ).json()
    assert history["items"][0]["actor"]["username"] == "receiver.corrector"


def test_manual_arrival_validates_order_and_history_pagination(
    authenticated_client: TestClient,
) -> None:
    missing = _change(
        authenticated_client,
        "999999",
        status="RECEIVED",
        revision=0,
        event_id="manual-missing-order-0001",
    )
    assert missing.status_code == 404
    assert authenticated_client.get(
        "/api/orders/999999/arrival-history"
    ).status_code == 404
    assert authenticated_client.get(
        "/api/orders/1/arrival-history", params={"limit": 0}
    ).status_code == 422


def test_closed_orders_ignore_historical_override_and_reject_changes(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    order = _seed_order(
        authenticated_client,
        sync_headers,
        order_id="ORDER-CLOSE-AFTER-MANUAL",
    )
    first = _change(
        authenticated_client,
        order["id"],
        status="RECEIVED",
        revision=0,
        event_id="manual-before-close-0001",
    )
    assert first.status_code == 200

    closed_payload = batch_payload("batch-close-after-manual-0002")
    closed_payload["orders"][0]["platform_order_id"] = "ORDER-CLOSE-AFTER-MANUAL"
    closed_payload["orders"][0]["status"] = "CANCELLED"
    assert post_batch(authenticated_client, closed_payload, sync_headers).status_code == 200

    listed = authenticated_client.get(
        "/api/orders", params={"query": "ORDER-CLOSE-AFTER-MANUAL"}
    ).json()["items"][0]
    assert listed["effective_arrival_status"] == "CLOSED"
    assert listed["arrival_source"] == "AUTO"
    assert listed["responsible_user"] is None
    assert listed["manual_revision"] == 1
    assert authenticated_client.get(
        "/api/orders", params={"arrival_status": "received"}
    ).json()["total"] == 0
    stats = authenticated_client.get("/api/dashboard/stats").json()
    assert stats["received_orders"] == 0
    assert stats["pending_orders"] == 0

    rejected = _change(
        authenticated_client,
        order["id"],
        status="PENDING",
        revision=1,
        event_id="manual-after-close-0002",
    )
    assert rejected.status_code == 409
    replay_rejected = _change(
        authenticated_client,
        order["id"],
        status="RECEIVED",
        revision=0,
        event_id="manual-before-close-0001",
    )
    assert replay_rejected.status_code == 409
