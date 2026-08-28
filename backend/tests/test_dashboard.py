from __future__ import annotations

from fastapi.testclient import TestClient

from test_sync_api import batch_payload, post_batch


def upload_receipt(
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
            "captured_at": "2026-08-28T10:20:30+08:00",
            "device_id": "dashboard-test-device",
            "tracking_no": tracking_no,
            "input_method": "PHOTO_CAPTURE",
        },
        files={"photo": (f"{event_id}.jpg", photo, "image/jpeg")},
    )
    assert response.status_code == 201
    return response.json()["receipt"]


def test_dashboard_stats_require_authentication(client: TestClient) -> None:
    response = client.get("/api/dashboard/stats")

    assert response.status_code == 401


def test_dashboard_stats_are_zero_for_empty_business_tables(
    authenticated_client: TestClient,
) -> None:
    response = authenticated_client.get("/api/dashboard/stats")

    assert response.status_code == 200
    assert response.json() == {
        "total_orders": 0,
        "arrival_photos": 0,
        "matched_orders": 0,
        "linked_orders": 0,
        "candidate_photos": 0,
        "unlinked_orders": 0,
        "pending_orders": 0,
        "unmatched_photos": 0,
        "account_count": 0,
    }


def test_dashboard_stats_count_orders_without_photos_as_pending(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    payload = batch_payload("b-dashboard-pending-0001")
    second_order = {
        **payload["orders"][0],
        "platform_order_id": "260828-0002",
        "items": [
            {
                **payload["orders"][0]["items"][0],
                "item_key": "item-2",
                "title": "第二件商品",
            }
        ],
        "packages": [],
    }
    payload["orders"].append(second_order)
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    response = authenticated_client.get("/api/dashboard/stats")

    assert response.status_code == 200
    assert response.json() == {
        "total_orders": 2,
        "arrival_photos": 0,
        "matched_orders": 0,
        "linked_orders": 0,
        "candidate_photos": 0,
        "unlinked_orders": 2,
        "pending_orders": 2,
        "unmatched_photos": 0,
        "account_count": 1,
    }


def test_dashboard_stats_deduplicate_orders_across_photos_and_packages(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
    jpeg_bytes: bytes,
) -> None:
    shared_tracking = "DASH-BOARD-001"
    first = batch_payload("b-dashboard-matches-0001")
    first["orders"] = [
        {
            **first["orders"][0],
            "platform_order_id": "dashboard-order-a",
            "packages": [
                {
                    "courier": "快递甲",
                    "tracking_no": shared_tracking,
                    "status": "SHIPPED",
                },
                {
                    "courier": "快递乙",
                    "tracking_no": shared_tracking,
                    "status": "SHIPPED",
                },
            ],
        },
        {
            **first["orders"][0],
            "platform_order_id": "dashboard-order-pending",
            "items": [
                {
                    **first["orders"][0]["items"][0],
                    "item_key": "pending-item",
                }
            ],
            "packages": [],
        },
        {
            **first["orders"][0],
            "platform_order_id": "dashboard-order-exact",
            "items": [
                {
                    **first["orders"][0]["items"][0],
                    "item_key": "exact-item",
                }
            ],
            "packages": [
                {
                    "courier": "快递甲",
                    "tracking_no": "EXACT-TRACKING-001",
                    "status": "SHIPPED",
                },
                {
                    "courier": "快递乙",
                    "tracking_no": "EXACT-TRACKING-001",
                    "status": "SHIPPED",
                },
            ],
        },
    ]
    assert post_batch(authenticated_client, first, sync_headers).status_code == 200

    second = batch_payload(
        "b-dashboard-matches-0002",
        platform="1688",
        platform_account_key="1688-dashboard",
    )
    second["orders"][0]["platform_order_id"] = "dashboard-order-b"
    second["orders"][0]["packages"] = [
        {
            "courier": "快递甲",
            "tracking_no": shared_tracking,
            "status": "SHIPPED",
        }
    ]
    assert post_batch(authenticated_client, second, sync_headers).status_code == 200

    upload_receipt(
        authenticated_client,
        event_id="dashboard-photo-0001",
        tracking_no="dashboard 001",
        photo=jpeg_bytes,
    )
    before_duplicate = authenticated_client.get("/api/dashboard/stats").json()
    duplicate = upload_receipt(
        authenticated_client,
        event_id="dashboard-photo-0002",
        tracking_no=shared_tracking,
        photo=jpeg_bytes + b"duplicate",
    )
    after_duplicate = authenticated_client.get("/api/dashboard/stats").json()
    assert duplicate["is_duplicate"] is True
    assert before_duplicate["arrival_photos"] == 1
    assert before_duplicate["candidate_photos"] == 1
    assert after_duplicate == before_duplicate

    upload_receipt(
        authenticated_client,
        event_id="dashboard-photo-0003",
        tracking_no="NO-MATCH-999",
        photo=jpeg_bytes + b"unmatched",
    )
    upload_receipt(
        authenticated_client,
        event_id="dashboard-photo-0004",
        tracking_no="exact tracking 001",
        photo=jpeg_bytes + b"exact",
    )
    upload_receipt(
        authenticated_client,
        event_id="dashboard-photo-failed",
        tracking_no="NO-MATCH-FAILED",
        photo=jpeg_bytes + b"failed",
    )
    with authenticated_client.app.state.database.connect() as connection:
        connection.execute(
            """
            UPDATE receipt_events SET evidence_status = 'FAILED'
            WHERE client_event_id = 'dashboard-photo-failed'
            """
        )
        connection.commit()

    response = authenticated_client.get("/api/dashboard/stats")

    assert response.status_code == 200
    assert response.json() == {
        "total_orders": 4,
        "arrival_photos": 3,
        "matched_orders": 1,
        "linked_orders": 3,
        "candidate_photos": 1,
        "unlinked_orders": 3,
        "pending_orders": 3,
        "unmatched_photos": 1,
        "account_count": 2,
    }
