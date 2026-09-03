from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient


ADMIN_PASSWORD = "correct horse battery staple"
RECEIVER_PASSWORD = "Receiver-Strong-2026!"


def _login(client: TestClient, username: str, password: str):
    client.post("/api/auth/logout")
    return client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )


def _create_user(
    client: TestClient,
    *,
    username: str = "receiver.one",
    role: str = "RECEIVER",
    password: str = RECEIVER_PASSWORD,
):
    return client.post(
        "/api/users",
        json={
            "username": username,
            "display_name": f"用户 {username}",
            "password": password,
            "role": role,
        },
    )


def test_user_management_requires_admin(
    client: TestClient,
    authenticated_client: TestClient,
) -> None:
    authenticated_client.post("/api/auth/logout")
    assert authenticated_client.get("/api/users").status_code == 401
    assert _login(authenticated_client, "admin", ADMIN_PASSWORD).status_code == 200
    created = _create_user(authenticated_client)
    assert created.status_code == 201
    receiver_id = created.json()["id"]

    assert _login(
        authenticated_client, "receiver.one", RECEIVER_PASSWORD
    ).status_code == 200
    assert authenticated_client.get("/api/users").status_code == 403
    assert authenticated_client.get("/api/users/audit-events").status_code == 403
    assert _create_user(
        authenticated_client, username="receiver.two"
    ).status_code == 403
    assert authenticated_client.patch(
        f"/api/users/{receiver_id}", json={"is_active": False}
    ).status_code == 403


def test_admin_can_create_list_deactivate_and_reactivate_users(
    authenticated_client: TestClient,
) -> None:
    created = _create_user(authenticated_client)
    assert created.status_code == 201
    created_body = created.json()
    assert created_body == {
        "id": created_body["id"],
        "username": "receiver.one",
        "display_name": "用户 receiver.one",
        "role": "RECEIVER",
        "is_active": True,
        "last_login_at": None,
    }
    assert "password" not in created.text.lower()
    assert "hash" not in created.text.lower()

    duplicate = _create_user(authenticated_client)
    assert duplicate.status_code == 409
    second_admin = _create_user(
        authenticated_client,
        username="admin.second",
        role="ADMIN",
        password="Second-Admin-2026!",
    )
    assert second_admin.status_code == 201
    assert second_admin.json()["role"] == "ADMIN"
    weak = _create_user(
        authenticated_client,
        username="receiver.weak",
        password="abcdefghijkl",
    )
    assert weak.status_code == 422
    invalid_username = _create_user(
        authenticated_client,
        username="bad user",
    )
    assert invalid_username.status_code == 422

    listed = authenticated_client.get("/api/users")
    assert listed.status_code == 200
    assert listed.json()["total"] == 3
    assert {item["username"] for item in listed.json()["items"]} == {
        "admin",
        "admin.second",
        "receiver.one",
    }
    assert all("password_hash" not in item for item in listed.json()["items"])

    assert _login(
        authenticated_client, "receiver.one", RECEIVER_PASSWORD
    ).status_code == 200

    assert _login(authenticated_client, "admin", ADMIN_PASSWORD).status_code == 200
    listed_after_login = authenticated_client.get("/api/users").json()["items"]
    receiver = next(
        item for item in listed_after_login if item["username"] == "receiver.one"
    )
    assert receiver["last_login_at"] is not None
    _login(authenticated_client, "admin", ADMIN_PASSWORD)
    disabled = authenticated_client.patch(
        f"/api/users/{created_body['id']}", json={"is_active": False}
    )
    assert disabled.status_code == 200
    assert disabled.json()["is_active"] is False
    with authenticated_client.app.state.database.connect() as connection:
        sessions = connection.execute(
            "SELECT revoked_at FROM sessions WHERE user_id = ?",
            (created_body["id"],),
        ).fetchall()
        assert sessions
        assert all(row["revoked_at"] is not None for row in sessions)
    assert _login(
        authenticated_client, "receiver.one", RECEIVER_PASSWORD
    ).status_code == 401

    assert _login(authenticated_client, "admin", ADMIN_PASSWORD).status_code == 200
    enabled = authenticated_client.patch(
        f"/api/users/{created_body['id']}", json={"is_active": True}
    )
    assert enabled.status_code == 200
    assert enabled.json()["is_active"] is True
    assert _login(
        authenticated_client, "receiver.one", RECEIVER_PASSWORD
    ).status_code == 200


def test_admin_cannot_deactivate_self_or_missing_user(
    authenticated_client: TestClient,
) -> None:
    me = authenticated_client.get("/api/auth/me").json()["user"]
    response = authenticated_client.patch(
        f"/api/users/{me['id']}", json={"is_active": False}
    )
    assert response.status_code == 409
    assert authenticated_client.get("/api/auth/me").status_code == 200
    assert authenticated_client.patch(
        "/api/users/999999", json={"is_active": False}
    ).status_code == 404


def test_password_byte_limit_accepts_72_and_rejects_more_than_72(
    authenticated_client: TestClient,
) -> None:
    ascii_72 = "Aa1!" + "x" * 68
    utf8_72 = "Aa1!" + "界" * 22 + "é"
    assert len(ascii_72.encode("utf-8")) == 72
    assert len(utf8_72.encode("utf-8")) == 72
    assert _create_user(
        authenticated_client,
        username="ascii.boundary",
        password=ascii_72,
    ).status_code == 201
    assert _create_user(
        authenticated_client,
        username="utf8.boundary",
        password=utf8_72,
    ).status_code == 201
    assert _login(
        authenticated_client, "ascii.boundary", ascii_72
    ).status_code == 200
    assert _login(
        authenticated_client, "utf8.boundary", utf8_72
    ).status_code == 200

    assert _login(authenticated_client, "admin", ADMIN_PASSWORD).status_code == 200
    for username, password in (
        ("ascii.too-long", "Aa1!" + "x" * 69),
        ("utf8.too-long", "Aa1!" + "界" * 23),
    ):
        assert len(password.encode("utf-8")) == 73
        rejected = _create_user(
            authenticated_client,
            username=username,
            password=password,
        )
        assert rejected.status_code == 422
        assert "72 UTF-8 bytes" in rejected.text

    oversized_login = authenticated_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "Aa1!" + "界" * 23},
    )
    assert oversized_login.status_code == 422
    assert "72 UTF-8 bytes" in oversized_login.text


def test_user_can_change_own_password_and_other_sessions_are_revoked(
    authenticated_client: TestClient,
) -> None:
    created = _create_user(authenticated_client, username="password.receiver")
    assert created.status_code == 201
    receiver_client = TestClient(authenticated_client.app)
    assert _login(receiver_client, "password.receiver", RECEIVER_PASSWORD).status_code == 200
    assert authenticated_client.post("/api/auth/login", json={
        "username": "password.receiver",
        "password": RECEIVER_PASSWORD,
    }).status_code == 200

    changed = receiver_client.post(
        "/api/auth/change-password",
        json={"current_password": RECEIVER_PASSWORD, "new_password": "New-Receiver-2026!"},
    )
    assert changed.status_code == 204
    assert receiver_client.get("/api/auth/me").status_code == 200

    old_session = TestClient(authenticated_client.app)
    assert _login(old_session, "password.receiver", RECEIVER_PASSWORD).status_code == 401
    assert _login(old_session, "password.receiver", "New-Receiver-2026!").status_code == 200
    receiver_client.close()
    old_session.close()


def test_change_password_rejects_wrong_current_and_weak_new_password(
    authenticated_client: TestClient,
) -> None:
    created = _create_user(authenticated_client, username="password.validation")
    assert created.status_code == 201
    client = TestClient(authenticated_client.app)
    assert _login(client, "password.validation", RECEIVER_PASSWORD).status_code == 200
    assert client.post(
        "/api/auth/change-password",
        json={"current_password": "wrong", "new_password": "New-Receiver-2026!"},
    ).status_code == 401
    weak = client.post(
        "/api/auth/change-password",
        json={"current_password": RECEIVER_PASSWORD, "new_password": "123456"},
    )
    assert weak.status_code == 422
    assert _login(client, "password.validation", RECEIVER_PASSWORD).status_code == 200
    client.close()


def test_user_management_audit_records_actor_target_and_history(
    authenticated_client: TestClient,
) -> None:
    created = _create_user(
        authenticated_client,
        username="audited.receiver",
    )
    assert created.status_code == 201
    target = created.json()
    assert authenticated_client.patch(
        f"/api/users/{target['id']}", json={"is_active": False}
    ).status_code == 200
    assert authenticated_client.patch(
        f"/api/users/{target['id']}", json={"is_active": True}
    ).status_code == 200

    audit = authenticated_client.get("/api/users/audit-events")
    assert audit.status_code == 200
    events = [
        event
        for event in audit.json()["items"]
        if event["target_user_id"] == target["id"]
    ]
    assert [event["action"] for event in reversed(events)] == [
        "CREATE",
        "DEACTIVATE",
        "ACTIVATE",
    ]
    assert all(event["actor_username"] == "admin" for event in events)
    assert all(event["target_username"] == "audited.receiver" for event in events)
    assert all(event["created_at"] for event in events)

    # Current account state changes never rewrite the immutable event snapshot.
    assert events[-1]["target_display_name"] == "用户 audited.receiver"
    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute(
            """
            SELECT COUNT(*) AS count FROM user_management_events
            WHERE target_user_id = ?
            """,
            (target["id"],),
        ).fetchone()["count"] == 3


def test_login_and_deactivation_share_write_transaction_and_do_not_resurrect_session(
    authenticated_client: TestClient,
    monkeypatch,
) -> None:
    created = _create_user(
        authenticated_client,
        username="racing.receiver",
    )
    assert created.status_code == 201
    receiver_id = created.json()["id"]

    import app.main as main_module

    original_verify = main_module.verify_password
    verification_started = threading.Event()
    allow_verification = threading.Event()
    deactivation_started = threading.Event()

    def blocking_verify(password: str, password_hash: str) -> bool:
        if password == RECEIVER_PASSWORD:
            verification_started.set()
            assert allow_verification.wait(timeout=5)
        return original_verify(password, password_hash)

    monkeypatch.setattr(main_module, "verify_password", blocking_verify)
    login_client = TestClient(authenticated_client.app)

    def login_receiver():
        return login_client.post(
            "/api/auth/login",
            json={
                "username": "racing.receiver",
                "password": RECEIVER_PASSWORD,
            },
        )

    def deactivate_receiver():
        deactivation_started.set()
        return authenticated_client.patch(
            f"/api/users/{receiver_id}", json={"is_active": False}
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            login_future = executor.submit(login_receiver)
            assert verification_started.wait(timeout=5)
            deactivate_future = executor.submit(deactivate_receiver)
            assert deactivation_started.wait(timeout=5)
            # The login owns BEGIN IMMEDIATE while password verification is
            # paused, so deactivation cannot pass its own write boundary yet.
            assert not deactivate_future.done()
            allow_verification.set()
            assert login_future.result(timeout=5).status_code == 200
            assert deactivate_future.result(timeout=5).status_code == 200

        with authenticated_client.app.state.database.connect() as connection:
            sessions = connection.execute(
                "SELECT revoked_at FROM sessions WHERE user_id = ?",
                (receiver_id,),
            ).fetchall()
            assert sessions
            assert all(row["revoked_at"] is not None for row in sessions)

        assert authenticated_client.patch(
            f"/api/users/{receiver_id}", json={"is_active": True}
        ).status_code == 200
        # Re-enabling the account does not clear revoked_at on old sessions.
        assert login_client.get("/api/auth/me").status_code == 401
    finally:
        allow_verification.set()
        login_client.close()
