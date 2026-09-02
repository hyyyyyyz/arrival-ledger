from __future__ import annotations

import sqlite3
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.database import Database, SCHEMA
from app.main import create_app

from test_sync_api import batch_payload, post_batch


def account_status_payload(**overrides) -> dict:
    payload = {
        "schema_version": 1,
        "worker_id": "mac-pdd-worker-01",
        "platform": "pdd",
        "platform_account_key": "pdd-main",
        "platform_account_label": "拼多多主账号",
        "status": "OK",
        "checked_at": "2026-08-30T10:15:30+08:00",
        "count": 12,
        "message": "同步正常",
    }
    payload.update(overrides)
    return payload


def test_account_status_requires_shared_worker_auth_and_honors_revocation(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    endpoint = "/api/sync/v1/account-status"
    assert client.post(endpoint, json=account_status_payload()).status_code == 401
    assert (
        client.post(
            endpoint,
            json=account_status_payload(),
            headers={"Authorization": "Bearer wrong-token"},
        ).status_code
        == 401
    )

    with client.app.state.database.connect() as connection:
        connection.execute(
            "UPDATE sync_worker_tokens SET revoked_at = '2026-08-30T00:00:00.000Z'"
        )
        connection.commit()
    assert (
        client.post(endpoint, json=account_status_payload(), headers=sync_headers).status_code
        == 403
    )


def test_account_status_unavailable_without_configured_tokens(settings) -> None:
    with TestClient(create_app(replace(settings, sync_worker_tokens=()))) as client:
        response = client.post(
            "/api/sync/v1/account-status",
            json=account_status_payload(),
            headers={"Authorization": "Bearer anything-at-all-0001"},
        )
    assert response.status_code == 503


def test_worker_status_upserts_account_and_preserves_last_success(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    endpoint = "/api/sync/v1/account-status"
    first = client.post(endpoint, json=account_status_payload(), headers=sync_headers)
    assert first.status_code == 200
    assert first.json() == {
        "id": first.json()["id"],
        "platform": "pdd",
        "account_key": "pdd-main",
        "display_label": "拼多多主账号",
        "source": "WINDOWS_BROWSER",
        "status": "OK",
        "worker_id": "mac-pdd-worker-01",
        "order_count": 0,
        "last_attempt_at": "2026-08-30T02:15:30Z",
        "last_success_at": "2026-08-30T02:15:30Z",
        "last_count": 12,
        "message": "同步正常",
        "created_at": first.json()["created_at"],
        "updated_at": first.json()["updated_at"],
        "status_updated_at": first.json()["status_updated_at"],
    }

    replay = client.post(endpoint, json=account_status_payload(), headers=sync_headers)
    assert replay.status_code == 200
    assert replay.json() == first.json()

    conflicting_replay = client.post(
        endpoint,
        json=account_status_payload(status="NETWORK_ERROR", message="late conflict"),
        headers=sync_headers,
    )
    assert conflicting_replay.status_code == 409
    assert conflicting_replay.json()["detail"] == (
        "conflicting account status report for checked_at"
    )
    with client.app.state.database.connect() as connection:
        still_first = connection.execute(
            """
            SELECT status, worker_id, last_attempt_at, last_count, message
            FROM platform_account_sync_state
            """
        ).fetchone()
    assert dict(still_first) == {
        "status": "OK",
        "worker_id": "mac-pdd-worker-01",
        "last_attempt_at": "2026-08-30T02:15:30.000Z",
        "last_count": 12,
        "message": "同步正常",
    }

    second_payload = account_status_payload(
        platform_account_label=None,
        status="NEEDS_LOGIN",
        checked_at="2026-08-30T03:30:00Z",
        count=None,
        message="登录已过期",
    )
    second = client.post(endpoint, json=second_payload, headers=sync_headers)
    assert second.status_code == 200
    body = second.json()
    assert body["display_label"] == "拼多多主账号"
    assert body["status"] == "NEEDS_LOGIN"
    assert body["last_attempt_at"] == "2026-08-30T03:30:00Z"
    assert body["last_success_at"] == "2026-08-30T02:15:30Z"
    assert body["last_count"] == 12

    with client.app.state.database.connect() as connection:
        account = connection.execute(
            "SELECT * FROM platform_accounts WHERE platform = 'pdd'"
        ).fetchone()
        state = connection.execute(
            "SELECT * FROM platform_account_sync_state"
        ).fetchone()
    assert account is not None
    assert account["source"] == "WINDOWS_BROWSER"
    assert state is not None
    assert state["worker_id"] == "mac-pdd-worker-01"
    assert "token" not in set(state.keys())

    stale = client.post(
        endpoint,
        json=account_status_payload(
            status="NETWORK_ERROR",
            checked_at="2026-08-30T03:00:00Z",
            count=1,
            message="delayed report",
        ),
        headers=sync_headers,
    )
    assert stale.status_code == 409
    with client.app.state.database.connect() as connection:
        unchanged = connection.execute(
            "SELECT status, last_attempt_at, last_count FROM platform_account_sync_state"
        ).fetchone()
    assert unchanged["status"] == "NEEDS_LOGIN"
    assert unchanged["last_attempt_at"] == "2026-08-30T03:30:00.000Z"
    assert unchanged["last_count"] == 12


def test_worker_status_rejects_future_clock_poisoning(
    client: TestClient, sync_headers: dict[str, str]
) -> None:
    future = datetime.now(timezone.utc) + timedelta(minutes=6)
    response = client.post(
        "/api/sync/v1/account-status",
        json=account_status_payload(checked_at=future.isoformat()),
        headers=sync_headers,
    )
    assert response.status_code == 422
    with client.app.state.database.connect() as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) AS count FROM platform_accounts"
            ).fetchone()["count"]
            == 0
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"schema_version": 2},
        {"platform": "1688"},
        {"platform_account_key": "中文账号"},
        {"platform_account_key": "../profile"},
        {"worker_id": "   "},
        {"status": "RUNNING"},
        {"checked_at": "2026-08-30T10:15:30"},
        {"count": -1},
        {"message": "x" * 257},
        {"cookie": "pdd-session-secret"},
    ],
)
def test_account_status_rejects_invalid_or_sensitive_fields(
    client: TestClient,
    sync_headers: dict[str, str],
    overrides: dict,
) -> None:
    response = client.post(
        "/api/sync/v1/account-status",
        json=account_status_payload(**overrides),
        headers=sync_headers,
    )
    assert response.status_code == 422


def test_admin_registers_lists_and_idempotently_renames_account(
    authenticated_client: TestClient, sync_headers: dict[str, str]
) -> None:
    created = authenticated_client.post(
        "/api/platform-accounts",
        json={
            "platform": "pdd",
            "account_key": "  Main.Buyer_01 ",
            "display_label": "采购一组",
        },
    )
    assert created.status_code == 200
    assert created.json()["account_key"] == "main.buyer_01"
    assert created.json()["status"] == "NEEDS_LOGIN"

    status_response = authenticated_client.post(
        "/api/sync/v1/account-status",
        json=account_status_payload(
            platform_account_key="main.buyer_01",
            platform_account_label=None,
        ),
        headers=sync_headers,
    )
    assert status_response.status_code == 200

    with authenticated_client.app.state.database.connect() as connection:
        connection.execute(
            """
            UPDATE platform_accounts
            SET source = 'ALI1688_API'
            WHERE platform = 'pdd' AND account_key = 'main.buyer_01'
            """
        )
        connection.commit()

    renamed = authenticated_client.post(
        "/api/platform-accounts",
        json={
            "platform": "pdd",
            "account_key": "main.buyer_01",
            "display_label": "采购一组（新）",
        },
    )
    assert renamed.status_code == 200
    assert renamed.json()["id"] == created.json()["id"]
    assert renamed.json()["display_label"] == "采购一组（新）"
    assert renamed.json()["source"] == "WINDOWS_BROWSER"
    assert renamed.json()["status"] == "OK"
    assert renamed.json()["last_success_at"] is not None

    batch = batch_payload(
        "b-account-list-0001",
        platform_account_key="main.buyer_01",
        platform_account_label="采购一组（新）",
    )
    assert post_batch(authenticated_client, batch, sync_headers).status_code == 200

    listed = authenticated_client.get("/api/platform-accounts?platform=pdd")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    item = listed.json()["items"][0]
    assert item["order_count"] == 1
    assert item["display_label"] == "采购一组（新）"
    serialized = str(listed.json()).lower()
    assert "token" not in serialized
    assert "profile" not in serialized


def test_platform_account_management_requires_admin(
    authenticated_client: TestClient, settings
) -> None:
    payload = {
        "platform": "pdd",
        "account_key": "receiver-account",
        "display_label": "接收员账号",
    }
    with TestClient(create_app(settings)) as unauthenticated:
        assert unauthenticated.get("/api/platform-accounts?platform=pdd").status_code == 401

    created_user = authenticated_client.post(
        "/api/users",
        json={
            "username": "receiver01",
            "display_name": "收货员一号",
            "password": "receiver passphrase 2026",
            "role": "RECEIVER",
        },
    )
    assert created_user.status_code == 201
    assert authenticated_client.post("/api/auth/logout").status_code == 204
    assert (
        authenticated_client.post(
            "/api/auth/login",
            json={
                "username": "receiver01",
                "password": "receiver passphrase 2026",
            },
        ).status_code
        == 200
    )
    assert authenticated_client.get("/api/platform-accounts?platform=pdd").status_code == 403
    assert authenticated_client.post("/api/platform-accounts", json=payload).status_code == 403


def test_platform_account_create_validation(authenticated_client: TestClient) -> None:
    cases = [
        {"platform": "1688", "account_key": "buyer-1", "display_label": "账号"},
        {"platform": "pdd", "account_key": "../buyer", "display_label": "账号"},
        {"platform": "pdd", "account_key": "buyer-1", "display_label": "   "},
        {
            "platform": "pdd",
            "account_key": "buyer-1",
            "display_label": "账号",
            "profile_path": "/secret/profile",
        },
    ]
    for payload in cases:
        assert authenticated_client.post("/api/platform-accounts", json=payload).status_code == 422
    assert authenticated_client.get("/api/platform-accounts?platform=1688").status_code == 422


def test_v8_migration_normalizes_only_pdd_account_source(tmp_path) -> None:
    path = tmp_path / "v7" / "arrival.db"
    path.parent.mkdir(parents=True)
    raw = sqlite3.connect(path)
    raw.row_factory = sqlite3.Row
    raw.executescript(SCHEMA)
    raw.executemany(
        """
        INSERT INTO platform_accounts(
            id, platform, account_key, display_label, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z',
                  '2026-08-01T00:00:00.000Z')
        """,
        (
            (1, "pdd", "legacy-pdd", "旧拼多多账号", "ALI1688_API"),
            (2, "1688", "legacy-1688", "旧1688账号", "ALI1688_API"),
        ),
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

    database = Database(path)
    database.initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-30T00:00:00.000Z",
    )
    with database.connect() as connection:
        rows = connection.execute(
            """
            SELECT platform, source FROM platform_accounts
            ORDER BY platform
            """
        ).fetchall()
        assert [dict(row) for row in rows] == [
            {"platform": "1688", "source": "ALI1688_API"},
            {"platform": "pdd", "source": "WINDOWS_BROWSER"},
        ]
        last_migration = connection.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1"
        ).fetchone()
        assert (last_migration["version"], last_migration["name"]) == (
            11,
            "manual_order_batches",
        )


def test_v7_migration_backfills_pdd_accounts_and_enforces_state_constraints(
    tmp_path,
) -> None:
    path = tmp_path / "v6" / "arrival.db"
    path.parent.mkdir(parents=True)
    raw = sqlite3.connect(path)
    raw.row_factory = sqlite3.Row
    raw.executescript(SCHEMA)
    raw.execute("DROP TABLE platform_account_sync_state")
    raw.execute(
        """
        INSERT INTO platform_accounts(
            id, platform, account_key, display_label, source, created_at, updated_at
        ) VALUES (
            1, 'pdd', 'legacy-pdd', '旧拼多多账号', 'WINDOWS_BROWSER',
            '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
        )
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

    database = Database(path)
    database.initialize(
        bootstrap_username="admin",
        bootstrap_password="correct horse battery staple",
        bootstrap_display_name="管理员",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-30T00:00:00.000Z",
    )
    with database.connect() as connection:
        state = connection.execute(
            "SELECT * FROM platform_account_sync_state WHERE platform_account_id = 1"
        ).fetchone()
        assert state is not None
        assert state["status"] == "NEEDS_LOGIN"
        assert state["last_count"] == 0
        last_migration = connection.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1"
        ).fetchone()
        assert (last_migration["version"], last_migration["name"]) == (
            11,
            "manual_order_batches",
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE platform_account_sync_state SET status = 'RUNNING' WHERE platform_account_id = 1"
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE platform_account_sync_state SET last_count = -1 WHERE platform_account_id = 1"
            )
