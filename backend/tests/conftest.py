from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings(tmp_path):
    return Settings(
        database_path=tmp_path / "db" / "arrival.db",
        media_dir=tmp_path / "media",
        session_secret="test-session-secret-that-is-long-enough",
        bootstrap_admin_username="admin",
        bootstrap_admin_password="correct horse battery staple",
        bootstrap_admin_display_name="测试管理员",
        cookie_secure=False,
        max_upload_bytes=1024 * 1024,
    )


@pytest.fixture
def client(settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def authenticated_client(client: TestClient) -> TestClient:
    response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "correct horse battery staple"},
    )
    assert response.status_code == 200
    return client


@pytest.fixture
def jpeg_bytes() -> bytes:
    # Upload validation intentionally relies on a bounded magic-number check.
    return b"\xff\xd8\xff\xe0" + b"arrival-ledger-test-image" + b"\xff\xd9"
