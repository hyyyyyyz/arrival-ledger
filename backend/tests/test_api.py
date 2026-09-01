from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from test_sync_api import batch_payload, post_batch


def login(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "correct horse battery staple"},
    )
    assert response.status_code == 200


def receipt_form(event_id: str, tracking_no: str = "SF1234567890") -> dict[str, str]:
    return {
        "client_event_id": event_id,
        "captured_at": "2026-08-08T10:20:30+08:00",
        "device_id": "wechat-test-device",
        "tracking_no": tracking_no,
        "input_method": "PHOTO_CAPTURE",
    }


def test_login_logout_and_current_user(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 401
    assert client.post(
        "/api/auth/login", json={"username": "admin", "password": "wrong-password"}
    ).status_code == 401

    response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "correct horse battery staple"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["username"] == "admin"
    assert response.json()["auth_required"] is True
    cookie_header = response.headers["set-cookie"].lower()
    assert "httponly" in cookie_header
    assert "samesite=lax" in cookie_header
    assert "secure" not in cookie_header

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["display_name"] == "测试管理员"

    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401


def test_receipt_upload_is_idempotent(
    authenticated_client: TestClient, settings, jpeg_bytes: bytes
) -> None:
    files = {"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")}
    first = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-idempotent-0001"),
        files=files,
    )
    assert first.status_code == 201
    first_body = first.json()
    assert first_body["created"] is True
    assert first_body["receipt"]["evidence_status"] == "READY"
    assert first_body["receipt"]["tracking_no"] == "SF1234567890"

    second = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-idempotent-0001"),
        files={"photo": ("different.jpg", jpeg_bytes + b"different", "image/jpeg")},
    )
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["created"] is False
    assert second_body["idempotent_replay"] is True
    assert second_body["receipt"]["is_duplicate"] is False
    assert second_body["receipt"]["id"] == first_body["receipt"]["id"]

    media_files = [
        path
        for path in Path(settings.media_dir).rglob("*")
        if path.is_file() and ".tmp" not in path.parts
    ]
    assert len(media_files) == 1
    assert authenticated_client.get("/api/receipts").json()["total"] == 1


def test_gallery_receipt_persists_photo_library_input_method(
    authenticated_client: TestClient, jpeg_bytes: bytes
) -> None:
    form = receipt_form("event-photo-library-0001")
    form["input_method"] = "PHOTO_LIBRARY"
    response = authenticated_client.post(
        "/api/receipts",
        data=form,
        files={"photo": ("gallery.jpg", jpeg_bytes, "image/jpeg")},
    )
    assert response.status_code == 201

    with authenticated_client.app.state.database.connect() as connection:
        stored = connection.execute(
            "SELECT input_method FROM receipt_events WHERE client_event_id = ?",
            (form["client_event_id"],),
        ).fetchone()
    assert stored["input_method"] == "PHOTO_LIBRARY"

    invalid = receipt_form("event-photo-library-invalid-0002")
    invalid["input_method"] = "FILE_IMPORT"
    rejected = authenticated_client.post(
        "/api/receipts",
        data=invalid,
        files={"photo": ("invalid.jpg", jpeg_bytes, "image/jpeg")},
    )
    assert rejected.status_code == 422


def test_duplicate_tracking_keeps_evidence_and_points_to_first(
    authenticated_client: TestClient, jpeg_bytes: bytes
) -> None:
    first = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-duplicate-0001", "YT 123-456"),
        files={"photo": ("first.jpg", jpeg_bytes, "image/jpeg")},
    ).json()["receipt"]
    second_response = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-duplicate-0002", "yt123456"),
        files={"photo": ("second.jpg", jpeg_bytes + b"2", "image/jpeg")},
    )
    assert second_response.status_code == 201
    second = second_response.json()["receipt"]
    assert second["id"] != first["id"]
    assert second["is_duplicate"] is True
    assert second["duplicate_of_id"] == first["id"]
    assert second["duplicate_of"]["server_received_at"] == first["server_received_at"]


def test_receipts_and_photos_require_authentication(
    client: TestClient, jpeg_bytes: bytes
) -> None:
    upload = client.post(
        "/api/receipts",
        data=receipt_form("event-unauthorized-0001"),
        files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
    )
    assert upload.status_code == 401
    assert client.get("/api/receipts").status_code == 401
    assert client.get("/api/receipts/1/photo").status_code == 401


def test_trusted_lan_mode_allows_direct_use(
    settings, jpeg_bytes: bytes
) -> None:
    trusted_settings = replace(
        settings,
        auth_required=False,
        trusted_user_username="admin",
    )
    with TestClient(create_app(trusted_settings)) as client:
        trusted_headers = {
            "Host": "192.168.1.5",
            "X-Real-IP": "192.168.1.20",
            "X-Arrival-Client": "wechat-h5",
        }
        me = client.get("/api/auth/me", headers={"Host": "192.168.1.5"})
        assert me.status_code == 403
        me = client.get("/api/auth/me", headers=trusted_headers)
        assert me.status_code == 200
        assert me.json()["auth_required"] is False
        assert me.json()["user"]["username"] == "admin"

        created = client.post(
            "/api/receipts",
            data=receipt_form("event-trusted-lan-0001"),
            files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
            headers=trusted_headers,
        )
        assert created.status_code == 201
        receipt = created.json()["receipt"]
        assert receipt["operator"]["username"] == "admin"
        assert client.get("/api/receipts", headers=trusted_headers).status_code == 200
        assert client.get(
            receipt["photo_url"], headers=trusted_headers
        ).status_code == 200

        assert client.post("/api/auth/logout").status_code == 204
        assert client.get("/api/auth/me", headers=trusted_headers).status_code == 200


def test_photo_read_and_tracking_patch(
    authenticated_client: TestClient, jpeg_bytes: bytes
) -> None:
    receipt = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-patch-0001", ""),
        files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
    ).json()["receipt"]

    photo = authenticated_client.get(receipt["photo_url"])
    assert photo.status_code == 200
    assert photo.content == jpeg_bytes
    assert photo.headers["content-type"].startswith("image/jpeg")

    patched = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json={
            "tracking_no": "  ZTO-9988  ",
            "expected_tracking_no": None,
            "client_event_id": "tracking-change-patch-0001",
        },
    )
    assert patched.status_code == 200
    assert patched.json()["tracking_no"] == "ZTO-9988"


def test_receipt_tracking_change_keeps_photographer_and_audits_modifier(
    authenticated_client: TestClient,
    jpeg_bytes: bytes,
    sync_headers: dict[str, str],
) -> None:
    order_payload = batch_payload("batch-tracking-responsibility-0001")
    order_payload["orders"][0]["platform_order_id"] = "TRACKING-RESPONSIBILITY-ORDER"
    order_payload["orders"][0]["packages"] = [
        {
            "courier": "圆通速递",
            "tracking_no": "YT-NEW-002",
            "status": "SHIPPED",
        }
    ]
    assert post_batch(authenticated_client, order_payload, sync_headers).status_code == 200

    created_user = authenticated_client.post(
        "/api/users",
        json={
            "username": "tracking.receiver",
            "display_name": "运单修正员",
            "password": "Tracking-Strong-2026!",
            "role": "RECEIVER",
        },
    )
    assert created_user.status_code == 201
    receipt = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-tracking-audit-0001", "SF-OLD-001"),
        files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
    ).json()["receipt"]
    assert receipt["operator"]["username"] == "admin"
    assert receipt["last_modified_by"] is None

    authenticated_client.post("/api/auth/logout")
    assert authenticated_client.post(
        "/api/auth/login",
        json={
            "username": "tracking.receiver",
            "password": "Tracking-Strong-2026!",
        },
    ).status_code == 200
    payload = {
        "tracking_no": "YT-NEW-002",
        "expected_tracking_no": "SF-OLD-001",
        "client_event_id": "tracking-change-event-0001",
    }
    changed = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking", json=payload
    )
    assert changed.status_code == 200
    changed_body = changed.json()
    assert changed_body["operator"]["username"] == "admin"
    assert changed_body["last_modified_by"]["username"] == "tracking.receiver"
    assert changed_body["last_modified_at"] is not None

    replay = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking", json=payload
    )
    assert replay.status_code == 200
    reused = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json={**payload, "tracking_no": "ZTO-OTHER-003"},
    )
    assert reused.status_code == 409
    listed = authenticated_client.get("/api/receipts").json()["items"][0]
    assert listed["operator"]["username"] == "admin"
    assert listed["last_modified_by"]["username"] == "tracking.receiver"
    order = authenticated_client.get(
        "/api/orders", params={"query": "TRACKING-RESPONSIBILITY-ORDER"}
    ).json()["items"][0]
    assert order["effective_arrival_status"] == "RECEIVED"
    assert order["arrival_source"] == "AUTO"
    assert order["responsible_user"]["username"] == "admin"
    assert order["changed_at"] == receipt["server_received_at"]
    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM receipt_change_events"
        ).fetchone()["count"] == 1


def test_tracking_update_rejects_stale_expected_value_and_supports_safe_replay(
    authenticated_client: TestClient,
    jpeg_bytes: bytes,
) -> None:
    receipt = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-tracking-lock-0001", "SF-LOCK-001"),
        files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
    ).json()["receipt"]
    first_payload = {
        "tracking_no": "YT-LOCK-002",
        "expected_tracking_no": "SF-LOCK-001",
        "client_event_id": "tracking-lock-change-0001",
    }
    first = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json=first_payload,
    )
    assert first.status_code == 200
    assert first.json()["tracking_no"] == "YT-LOCK-002"

    stale = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json={
            "tracking_no": "ZTO-LOCK-003",
            "expected_tracking_no": "SF-LOCK-001",
            "client_event_id": "tracking-lock-change-0002",
        },
    )
    assert stale.status_code == 409
    assert authenticated_client.get("/api/receipts").json()["items"][0][
        "tracking_no"
    ] == "YT-LOCK-002"

    replay = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json=first_payload,
    )
    assert replay.status_code == 200
    assert replay.json()["tracking_no"] == "YT-LOCK-002"
    conflicting_replay = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json={**first_payload, "expected_tracking_no": None},
    )
    assert conflicting_replay.status_code == 409

    second = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json={
            "tracking_no": "ZTO-LOCK-003",
            "expected_tracking_no": "YT-LOCK-002",
            "client_event_id": "tracking-lock-change-0003",
        },
    )
    assert second.status_code == 200
    superseded_replay = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json=first_payload,
    )
    assert superseded_replay.status_code == 409

    missing_contract = authenticated_client.patch(
        f"/api/receipts/{receipt['id']}/tracking",
        json={"tracking_no": "ZTO-LOCK-003"},
    )
    assert missing_contract.status_code == 422
    with authenticated_client.app.state.database.connect() as connection:
        events = connection.execute(
            """
            SELECT previous_tracking_no, new_tracking_no
            FROM receipt_change_events WHERE receipt_id = ?
            ORDER BY id
            """,
            (receipt["id"],),
        ).fetchall()
    assert [tuple(event) for event in events] == [
        ("SF-LOCK-001", "YT-LOCK-002"),
        ("YT-LOCK-002", "ZTO-LOCK-003"),
    ]


def test_concurrent_tracking_corrections_allow_exactly_one_winner(
    authenticated_client: TestClient,
    jpeg_bytes: bytes,
) -> None:
    receipt = authenticated_client.post(
        "/api/receipts",
        data=receipt_form("event-tracking-race-0001", "SF-RACE-001"),
        files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
    ).json()["receipt"]

    def correct(tracking_no: str, event_id: str):
        return authenticated_client.patch(
            f"/api/receipts/{receipt['id']}/tracking",
            json={
                "tracking_no": tracking_no,
                "expected_tracking_no": "SF-RACE-001",
                "client_event_id": event_id,
            },
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(
            executor.map(
                lambda arguments: correct(*arguments),
                (
                    ("YT-RACE-002", "tracking-race-change-0001"),
                    ("ZTO-RACE-003", "tracking-race-change-0002"),
                ),
            )
        )
    assert sorted(response.status_code for response in responses) == [200, 409]
    winner = next(
        response.json()["tracking_no"]
        for response in responses
        if response.status_code == 200
    )
    listed = authenticated_client.get("/api/receipts").json()["items"][0]
    assert listed["tracking_no"] == winner
    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute(
            """
            SELECT COUNT(*) AS count FROM receipt_change_events
            WHERE receipt_id = ?
            """,
            (receipt["id"],),
        ).fetchone()["count"] == 1
