from __future__ import annotations

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
