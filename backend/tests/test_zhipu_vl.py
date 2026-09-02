from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError

from fastapi.testclient import TestClient

from app.main import create_app
from app.zhipu_vl import extract_tracking_candidates, parse_tracking_candidates, resolve_tracking_candidate


def test_parse_tracking_candidates_prefers_json_fields_and_deduplicates() -> None:
    text = json.dumps(
        {
            "tracking_numbers": ["YT 123-456-7890", "YT1234567890"],
            "note": "订单号 5127391766004024245，不是运单号",
        },
        ensure_ascii=False,
    )
    assert parse_tracking_candidates(text)[:2] == ["YT1234567890", "5127391766004024245"]


def test_extract_tracking_candidates_sends_image_and_parses_response() -> None:
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(
                {"choices": [{"message": {"content": '{"tracking_numbers":["SF1234567890000"]}'}}]}
            ).encode()

    seen: dict[str, object] = {}

    def opener(request, timeout):
        seen["authorization"] = request.headers["Authorization"]
        seen["timeout"] = timeout
        seen["body"] = json.loads(request.data.decode())
        return FakeResponse()

    with TemporaryDirectory() as directory:
        image = Path(directory) / "parcel.jpg"
        image.write_bytes(b"fake-image")
        assert extract_tracking_candidates(
            image, api_key="unit-key", timeout_seconds=3, opener=opener
        ) == ["SF1234567890000"]
    assert seen["authorization"] == "Bearer unit-key"
    assert seen["timeout"] == 3


def test_extract_tracking_candidates_provider_error_is_fail_open() -> None:
    def opener(*_args, **_kwargs):
        raise HTTPError("https://example.invalid", 429, "busy", {}, None)

    with TemporaryDirectory() as directory:
        image = Path(directory) / "parcel.jpg"
        image.write_bytes(b"fake-image")
        assert extract_tracking_candidates(image, api_key="unit-key", opener=opener) == []


def test_resolve_tracking_candidate_requires_database_match(settings) -> None:
    database = create_app(settings)
    with TestClient(database) as client:
        with client.app.state.database.connect() as connection:
            assert resolve_tracking_candidate(connection, ["SF1234567890000"]) is None


def test_resolve_tracking_candidate_returns_display_value(settings) -> None:
    database = create_app(settings)
    with TestClient(database) as client:
        with client.app.state.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO platform_accounts(platform, account_key, source, created_at, updated_at)
                VALUES ('pdd', 'candidate-test', 'WINDOWS_BROWSER', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
                """
            )
            account_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            connection.execute(
                """
                INSERT INTO purchase_orders(platform_account_id, platform_order_id, ordered_at, order_status, source, last_seen_at, created_at, updated_at)
                VALUES (?, 'candidate-order', '2026-08-01T00:00:00Z', 'SHIPPED', 'WINDOWS_BROWSER', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
                """,
                (account_id,),
            )
            connection.execute(
                """
                INSERT INTO packages(courier, courier_normalized, tracking_no, tracking_no_normalized, package_status, source, created_at, updated_at)
                VALUES ('顺丰速运', 'shunfeng', 'SF 1234567890000', 'SF1234567890000', 'SHIPPED', 'WINDOWS_BROWSER', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
                """
            )
            package_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            order_id = connection.execute("SELECT id FROM purchase_orders WHERE platform_order_id='candidate-order'").fetchone()["id"]
            connection.execute(
                "INSERT INTO package_order_links(package_id, order_id, created_at) VALUES (?, ?, '2026-08-01T00:00:00Z')",
                (package_id, order_id),
            )
            connection.commit()
            assert resolve_tracking_candidate(connection, ["other99999999", "SF1234567890000"]) == (
                "SF 1234567890000",
                "SF1234567890000",
            )


def test_receipt_uses_vl_only_when_client_barcode_missing(settings, jpeg_bytes, monkeypatch) -> None:
    vl_settings = replace(settings, zhipu_vl_api_key="unit-test-key")
    app = create_app(vl_settings)
    calls: list[Path] = []

    def fake_extract(path: Path, **_kwargs):
        calls.append(path)
        assert path.exists()
        return ["SF1234567890000"]

    monkeypatch.setattr("app.main.extract_tracking_candidates", fake_extract)
    with TestClient(app) as client:
        assert client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "correct horse battery staple"},
        ).status_code == 200
        with client.app.state.database.connect() as connection:
            connection.execute(
                "INSERT INTO platform_accounts(platform, account_key, source, created_at, updated_at) VALUES ('pdd', 'vl-test', 'WINDOWS_BROWSER', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')"
            )
            account_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            connection.execute(
                "INSERT INTO purchase_orders(platform_account_id, platform_order_id, ordered_at, order_status, source, last_seen_at, created_at, updated_at) VALUES (?, 'vl-order', '2026-08-01T00:00:00Z', 'SHIPPED', 'WINDOWS_BROWSER', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')",
                (account_id,),
            )
            connection.execute(
                "INSERT INTO packages(courier, courier_normalized, tracking_no, tracking_no_normalized, package_status, source, created_at, updated_at) VALUES ('顺丰速运', 'shunfeng', 'SF1234567890000', 'SF1234567890000', 'SHIPPED', 'WINDOWS_BROWSER', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')"
            )
            package_id = connection.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            order_id = connection.execute("SELECT id FROM purchase_orders WHERE platform_order_id='vl-order'").fetchone()["id"]
            connection.execute("INSERT INTO package_order_links(package_id, order_id, created_at) VALUES (?, ?, '2026-08-01T00:00:00Z')", (package_id, order_id))
            connection.commit()
        response = client.post(
            "/api/receipts",
            data={
                "client_event_id": "vl-fallback-event-0001",
                "captured_at": "2026-08-08T10:20:30+08:00",
                "device_id": "vl-test-device",
            },
            files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
        )
        assert response.status_code == 201
        body = response.json()["receipt"]
        assert body["tracking_no"] == "SF1234567890000"
        assert body["order_matches"][0]["platform_order_id"] == "vl-order"
        assert len(calls) == 1


def test_receipt_with_client_barcode_does_not_call_vl(settings, jpeg_bytes, monkeypatch) -> None:
    vl_settings = replace(settings, zhipu_vl_api_key="unit-test-key")
    app = create_app(vl_settings)
    monkeypatch.setattr("app.main.extract_tracking_candidates", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("VL should not run")))
    with TestClient(app) as client:
        assert client.post("/api/auth/login", json={"username": "admin", "password": "correct horse battery staple"}).status_code == 200
        response = client.post(
            "/api/receipts",
            data={
                "client_event_id": "vl-fast-path-event-0001",
                "captured_at": "2026-08-08T10:20:30+08:00",
                "device_id": "vl-test-device",
                "tracking_no": "SF1234567890000",
            },
            files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
        )
        assert response.status_code == 201
