from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


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
        json={"tracking_no": "  ZTO-9988  "},
    )
    assert patched.status_code == 200
    assert patched.json()["tracking_no"] == "ZTO-9988"
