from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.ali1688_client import Ali1688Client, Ali1688TransientError, ClientLimits, classify_error
from app.ali1688_config import Ali1688Account, Ali1688App, Ali1688Config, Ali1688ConfigError, load_config, parse_config
from app.cli import main as cli_main
from app.config import Settings
from app.ali1688_mapping import map_order
from app.ali1688_signing import build_param2_request
from app.ali1688_sync import format_api_datetime, sync_account, sync_config
from app.database import Database
from app.main import create_app


APP = Ali1688App("app-123", "secret-123", (Ali1688Account("buyer-a", "token-a"),))
ACCOUNT = APP.accounts[0]


def test_config_supports_multiple_accounts_without_secret_repr_leak() -> None:
    config = parse_config(
        {
            "apps": [
                {
                    "app_key": "app-123",
                    "app_secret": "app-secret",
                    "accounts": [
                        {"account_key": "one", "access_token": "token-one"},
                        {"account_key": "two", "access_token": "token-two"},
                    ],
                }
            ]
        }
    )
    rendered = repr(config) + repr(config.apps[0]) + repr(config.apps[0].accounts[0])
    assert "token-one" not in rendered
    assert "app-secret" not in rendered
    assert {account.account_key for _, account in config.accounts()} == {"one", "two"}


def test_config_rejects_more_than_five_accounts_per_app() -> None:
    try:
        parse_config(
            {
                "apps": [
                    {
                        "app_key": "app-123",
                        "app_secret": "app-secret",
                        "accounts": [
                            {"account_key": f"buyer-{index}", "access_token": f"token-{index}"}
                            for index in range(6)
                        ],
                    }
                ]
            }
        )
    except ValueError as exc:
        assert "limit of 5" in str(exc)
    else:
        raise AssertionError("six accounts in one 1688 app must be rejected")


def test_config_rejects_unsafe_account_keys_and_duplicate_apps() -> None:
    with pytest.raises(Ali1688ConfigError, match="account_key must use"):
        parse_config(
            {
                "apps": [
                    {
                        "app_key": "app-123",
                        "app_secret": "secret",
                        "accounts": [{"account_key": "采购 手机号", "access_token": "token"}],
                    }
                ]
            }
        )
    with pytest.raises(Ali1688ConfigError, match="duplicate app_key"):
        parse_config(
            {
                "apps": [
                    {"app_key": "same", "app_secret": "one", "accounts": []},
                    {"app_key": "same", "app_secret": "two", "accounts": []},
                ]
            }
        )


def test_config_doctor_reads_secret_file_while_scheduler_is_disabled(tmp_path, monkeypatch, capsys) -> None:
    secret_path = tmp_path / "ali1688.json"
    secret_path.write_text(
        json.dumps(
            {
                "apps": [
                    {
                        "app_key": "app-123",
                        "app_secret": "never-print-this-secret",
                        "accounts": [
                            {"account_key": "buyer-a", "access_token": "never-print-this-token"}
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    secret_path.chmod(0o600)
    monkeypatch.setenv("ALI1688_API_ENABLED", "false")
    monkeypatch.setenv("ALI1688_CONFIG_PATH", str(secret_path))
    assert cli_main(["config-doctor"]) == 0
    output = capsys.readouterr().out
    assert json.loads(output) == {"enabled": True, "apps": 1, "accounts": 1}
    assert "never-print" not in output


def test_secret_config_rejects_world_readable_permissions(tmp_path) -> None:
    secret_path = tmp_path / "ali1688.json"
    secret_path.write_text(
        json.dumps(
            {
                "apps": [
                    {
                        "app_key": "app-123",
                        "app_secret": "secret",
                        "accounts": [
                            {"account_key": "buyer-a", "access_token": "token"}
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    secret_path.chmod(0o644)
    with pytest.raises(Ali1688ConfigError, match="0600 or 0640"):
        load_config(secret_path)


def test_secret_config_rejects_symlinks(tmp_path) -> None:
    target_path = tmp_path / "target.json"
    target_path.write_text('{"apps": []}\n', encoding="utf-8")
    target_path.chmod(0o600)
    link_path = tmp_path / "ali1688.json"
    link_path.symlink_to(target_path)
    with pytest.raises(Ali1688ConfigError, match="cannot read|regular file"):
        load_config(link_path)


def test_sync_cli_rejects_empty_config(tmp_path, monkeypatch, capsys) -> None:
    secret_path = tmp_path / "ali1688.json"
    secret_path.write_text('{"apps": []}\n', encoding="utf-8")
    monkeypatch.setenv("ALI1688_CONFIG_PATH", str(secret_path))
    assert cli_main(["sync-once", "--all", "--dry-run"]) == 2
    assert "no authorized accounts" in capsys.readouterr().err


def test_param2_signature_matches_independent_hmac_sha1_vector() -> None:
    path = "param2/1/com.alibaba.trade/alibaba.trade.getBuyerOrderList/app-123"
    params = {"pageSize": 20, "access_token": "token", "page": 1}
    expected_raw = path + "access_token" + "token" + "page" + "1" + "pageSize" + "20"
    expected = hmac.new(b"secret", expected_raw.encode(), hashlib.sha1).hexdigest().upper()
    assert build_param2_request(path, params, "secret")["_aop_signature"] == expected


class Response:
    status_code = 200

    def __init__(self, body: dict) -> None:
        self.content = json.dumps(body).encode()
        self._body = body

    def json(self) -> dict:
        return self._body


class RecordingTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict, float]] = []

    def post(self, url: str, *, data: dict, timeout: float) -> Response:
        self.calls.append((url, data, timeout))
        return Response({"result": []})


def test_client_posts_signed_form_with_modify_window_and_no_duplicate_app_key() -> None:
    transport = RecordingTransport()
    client = Ali1688Client(
        APP,
        ACCOUNT,
        base_url="https://example.invalid/openapi",
        transport=transport,
        now_ms=lambda: 1720000000123,
        limits=ClientLimits(retries=0),
    )
    client.get_buyer_order_list(
        modify_start_time="20260828140000000+0800",
        modify_end_time="20260828150000000+0800",
        page=2,
        page_size=20,
    )
    url, form, timeout = transport.calls[0]
    assert url.endswith("/param2/1/com.alibaba.trade/alibaba.trade.getBuyerOrderList/app-123")
    assert form["modifyStartTime"] == "20260828140000000+0800"
    assert form["_aop_timestamp"] == "1720000000123"
    assert "app_key" not in form
    assert "_aop_datePattern" not in form
    assert timeout == 15.0


def test_client_retries_only_transient_http_failures_without_leaking_body() -> None:
    class RetryTransport(RecordingTransport):
        def __init__(self) -> None:
            super().__init__()
            self.attempt = 0

        def post(self, url: str, *, data: dict, timeout: float):
            self.attempt += 1
            self.calls.append((url, data, timeout))
            if self.attempt == 1:
                response = Response({"error_response": {"code": "SYSTEM_BUSY", "msg": "busy"}})
                response.status_code = 503
                return response
            return Response({"result": []})

    transport = RetryTransport()
    waits: list[float] = []
    client = Ali1688Client(
        APP,
        ACCOUNT,
        transport=transport,
        sleep=waits.append,
        limits=ClientLimits(retries=1, base_backoff_seconds=0),
    )
    assert client.get_buyer_order_list() == {"result": []}
    assert transport.attempt == 2
    assert len(waits) == 1
    assert all(call[1]["access_token"] == "token-a" for call in transport.calls)


def test_http_200_system_busy_is_transient_and_retried() -> None:
    assert classify_error(200, {"error_response": {"code": "SYSTEM_BUSY"}}) is Ali1688TransientError

    class BusyTransport(RecordingTransport):
        def post(self, url: str, *, data: dict, timeout: float):
            self.calls.append((url, data, timeout))
            if len(self.calls) == 1:
                return Response({"error_response": {"code": "SYSTEM_BUSY"}})
            return Response({"result": []})

    transport = BusyTransport()
    client = Ali1688Client(
        APP,
        ACCOUNT,
        transport=transport,
        sleep=lambda _seconds: None,
        limits=ClientLimits(retries=1, base_backoff_seconds=0),
    )
    assert client.get_buyer_order_list() == {"result": []}
    assert len(transport.calls) == 2


def test_mapping_parses_official_date_sku_ids_packages_and_excludes_pii() -> None:
    mapped = map_order(
        {
            "baseInfo": {
                "idOfStr": "1925514500832299999",
                "status": "waitbuyerreceive",
                "createTime": "20260828142334000+0800",
                "sellerLoginId": "shop-a",
                "receiverInfo": {"toMobile": "13800000000", "toArea": "private"},
            },
            "productItems": [
                {
                    "productID": 123,
                    "subItemIDString": "line-1",
                    "name": "商品 A",
                    "skuInfos": [{"name": "颜色", "value": "红色"}],
                    "quantity": 2,
                    "price": 4.50,
                },
                {
                    "productID": 123,
                    "subItemIDString": "line-2",
                    "name": "商品 A",
                    "skuInfos": [{"name": "颜色", "value": "蓝色"}],
                    "quantity": 1,
                    "price": "5.00",
                },
            ],
        },
        {
            "nativeLogistics": {
                "contactPerson": "private",
                "mobile": "13800000000",
                "logisticsItems": [
                    {
                        "logisticsBillNo": "不需要物流",
                        "logisticsCode": "SF123456789",
                        "logisticsCompanyName": "顺丰速运",
                        "status": "alreadysend",
                    },
                    {
                        "logisticsBillNo": "YT987654321",
                        "logisticsCompanyName": "圆通",
                        "status": "signinsuccess",
                    },
                ],
            }
        },
    )
    assert mapped.platform_order_id == "1925514500832299999"
    assert mapped.ordered_at == datetime(2026, 8, 28, 14, 23, 34, tzinfo=timezone(timedelta(hours=8)))
    assert [item.item_key for item in mapped.items] == ["line-1", "line-2"]
    assert mapped.items[0].sku_text == "颜色: 红色"
    assert [package.tracking_no for package in mapped.packages] == ["SF123456789", "YT987654321"]
    assert [package.status for package in mapped.packages] == ["SHIPPED", "DELIVERED"]
    assert all("13800000000" not in repr(mapped_item) for mapped_item in mapped.items)


def test_mapping_refuses_numeric_order_id_fallback() -> None:
    with pytest.raises(ValueError, match="idOfStr"):
        map_order({"baseInfo": {"id": 888888888888888888}, "productItems": []})


@pytest.mark.parametrize(
    "mutate,match",
    [
        (lambda order, detail: order["baseInfo"].update(status="new-unknown-state"), "unknown status"),
        (lambda order, detail: order.update(productItems=[]), "no productItems"),
        (lambda order, detail: order["baseInfo"].update(createTime="2026-08-28T14:23:34"), "timezone offset"),
        (
            lambda order, detail: detail["nativeLogistics"].update(
                logisticsItems=[{"status": "alreadysend"}]
            ),
            "no usable tracking number",
        ),
        (
            lambda order, detail: detail["nativeLogistics"]["logisticsItems"][0].update(
                status="new-logistics-state"
            ),
            "unknown status",
        ),
    ],
)
def test_mapping_fails_closed_on_incomplete_official_fields(mutate, match) -> None:
    order = {
        "baseInfo": {
            "idOfStr": "888888888888888888",
            "status": "waitbuyerreceive",
            "createTime": "20260828142334000+0800",
        },
        "productItems": [
            {
                "subItemIDString": "line-1",
                "name": "商品",
                "quantity": 1,
            }
        ],
    }
    detail = {
        "nativeLogistics": {
            "logisticsItems": [
                {"logisticsBillNo": "SF1234567890000", "status": "alreadysend"}
            ]
        }
    }
    mutate(order, detail)
    with pytest.raises(ValueError, match=match):
        map_order(order, detail)


@pytest.mark.parametrize(
    ("raw_status", "expected_status"),
    [("cancel", "CANCELLED"), ("refundsuccess", "REFUNDED")],
)
def test_mapping_ignores_only_unusable_historical_logistics_on_closed_order(
    raw_status: str,
    expected_status: str,
) -> None:
    order = {
        "baseInfo": {
            "idOfStr": "888888888888888888",
            "status": raw_status,
            "createTime": "20260828142334000+0800",
        },
        "productItems": [
            {
                "subItemIDString": "line-1",
                "name": "已取消商品",
                "quantity": 1,
            }
        ],
    }
    detail = {
        "nativeLogistics": {
            "logisticsItems": [
                {"status": "alreadysend"},
                {
                    "logisticsBillNo": "SF1234567890000",
                    "status": "signinsuccess",
                },
            ],
        }
    }

    mapped = map_order(order, detail)

    assert mapped.status == expected_status
    assert [package.tracking_no for package in mapped.packages] == ["SF1234567890000"]


def test_mapping_closed_order_still_rejects_non_object_logistics_row() -> None:
    order = {
        "baseInfo": {
            "idOfStr": "888888888888888888",
            "status": "cancel",
            "createTime": "20260828142334000+0800",
        },
        "productItems": [
            {
                "subItemIDString": "line-1",
                "name": "已取消商品",
                "quantity": 1,
            }
        ],
    }

    with pytest.raises(ValueError, match="non-object"):
        map_order(
            order,
            {"nativeLogistics": {"logisticsItems": [None]}},
        )


def _database(tmp_path) -> Database:
    database = Database(tmp_path / "arrival.db")
    database.initialize(
        bootstrap_username="admin",
        bootstrap_password="a sufficiently long test password",
        bootstrap_display_name="Admin",
        session_secret="test-session-secret-that-is-long-enough",
        sync_worker_tokens=(),
        now="2026-08-28T06:00:00.000Z",
    )
    return database


class SyncClient:
    def __init__(self, account_key: str, *, fail_detail: bool = False) -> None:
        self.account_key = account_key
        self.fail_detail = fail_detail
        self.list_calls: list[dict] = []

    def get_buyer_order_list(self, **kwargs):
        self.list_calls.append(kwargs)
        return {
            "result": [
                {
                    "baseInfo": {
                        "idOfStr": f"192551450083229{self.account_key[-1]}",
                        "status": "waitbuyerreceive",
                        "createTime": "20260828142334000+0800",
                    },
                    "productItems": [{"productID": "p1", "name": self.account_key, "quantity": 1}],
                }
            ]
        }

    def get_buyer_view(self, order_id: str):
        if self.fail_detail:
            raise RuntimeError("simulated detail failure")
        return {"result": {"nativeLogistics": {"logisticsItems": [{"logisticsBillNo": f"SF-{self.account_key}-1", "logisticsCompanyName": "SF"}]}}}


def test_sync_dry_run_does_not_create_state_or_orders(tmp_path) -> None:
    database = _database(tmp_path)
    client = SyncClient("buyer-a")
    result = sync_account(database, APP, ACCOUNT, client=client, dry_run=True)
    assert result["status"] == "DRY_RUN"
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM ali1688_sync_state").fetchone()["c"] == 0
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 0
    assert client.list_calls[0]["modify_start_time"]
    assert client.list_calls[0]["modify_start_time"].endswith("+0800")


def test_sync_config_isolates_accounts_and_keeps_cursors_separate(tmp_path) -> None:
    database = _database(tmp_path)
    app = Ali1688App("app-123", "secret-123", (ACCOUNT, Ali1688Account("buyer-b", "token-b")))
    second = app.accounts[1]
    first_result = sync_account(database, app, ACCOUNT, client=SyncClient("buyer-a"))
    second_result = sync_account(database, app, second, client=SyncClient("buyer-b"))
    assert first_result["status"] == second_result["status"] == "OK"
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT account_key, cursor FROM ali1688_sync_state ORDER BY account_key"
        ).fetchall()
        assert [row["account_key"] for row in rows] == ["buyer-a", "buyer-b"]
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 2


def test_sync_failure_isolated_and_does_not_commit_partial_orders(tmp_path) -> None:
    database = _database(tmp_path)
    failing = SyncClient("buyer-a", fail_detail=True)
    result = sync_account(database, APP, ACCOUNT, client=failing)
    assert result["status"] == "ERROR"
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 0
        state = connection.execute(
            "SELECT cursor, last_error_code FROM ali1688_sync_state WHERE account_key = 'buyer-a'"
        ).fetchone()
        assert state["cursor"] is None
        assert state["last_error_code"] == "SYNC_FAILED"


@pytest.mark.parametrize(
    "list_payload,detail_payload",
    [
        ({"unexpected": []}, None),
        (
            {
                "result": [
                    {
                        "baseInfo": {"idOfStr": "888888888888888888", "status": "success"},
                        "productItems": [{"subItemIDString": "line-1", "name": "商品", "quantity": 1}],
                    }
                ]
            },
            {"unexpected": {}},
        ),
        (
            {
                "result": [
                    {
                        "baseInfo": {"id": 888888888888888888, "status": "success"},
                        "productItems": [{"subItemIDString": "line-1", "name": "商品", "quantity": 1}],
                    }
                ]
            },
            None,
        ),
        (
            {
                "result": [
                    {
                        "baseInfo": {
                            "idOfStr": "888888888888888888",
                            "status": "success",
                            "createTime": "20260828142334000+0800",
                        },
                        "productItems": [
                            {
                                "subItemIDString": "line-1",
                                "name": "商品",
                                "quantity": 1,
                            }
                        ],
                    },
                    None,
                ]
            },
            None,
        ),
    ],
)
def test_unknown_api_shapes_fail_closed_without_advancing_cursor(tmp_path, list_payload, detail_payload) -> None:
    database = _database(tmp_path)

    class ChangedShapeClient:
        def get_buyer_order_list(self, **_kwargs):
            return list_payload

        def get_buyer_view(self, _order_id: str):
            return detail_payload

    result = sync_account(database, APP, ACCOUNT, client=ChangedShapeClient())
    assert result["status"] == "ERROR"
    assert result["error_code"] == "VALIDATION_ERROR"
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 0
        assert connection.execute(
            "SELECT cursor FROM ali1688_sync_state WHERE account_key = 'buyer-a'"
        ).fetchone()["cursor"] is None


def test_page_cap_keeps_cursor_unadvanced_for_safe_repeat(tmp_path) -> None:
    database = _database(tmp_path)

    class FullPageClient(SyncClient):
        def get_buyer_order_list(self, **kwargs):
            self.list_calls.append(kwargs)
            # Every page is full, so max_pages is a deliberate safety cap.
            return {
                "result": [
                    {
                            "baseInfo": {
                                "idOfStr": f"192551450083229{kwargs['page']}",
                                "status": "success",
                                "createTime": "20260828142334000+0800",
                            },
                        "productItems": [{"productID": "p", "name": "item", "quantity": 1}],
                    }
                ]
            }

    result = sync_account(database, APP, ACCOUNT, client=FullPageClient("buyer-a"), page_size=1, max_pages=1)
    assert result["status"] == "PARTIAL"
    with database.connect() as connection:
        state = connection.execute(
            "SELECT cursor, last_success_at, last_error_code FROM ali1688_sync_state WHERE account_key = 'buyer-a'"
        ).fetchone()
        assert state["cursor"] is None
        assert state["last_success_at"] is None
        assert state["last_error_code"] == "PAGE_CAP_REACHED"
        run = connection.execute(
            "SELECT status FROM ali1688_sync_runs WHERE account_key = 'buyer-a'"
        ).fetchone()
        assert run["status"] == "PARTIAL"


def test_more_than_one_hundred_orders_are_chunked_in_one_atomic_sync(tmp_path) -> None:
    database = _database(tmp_path)

    class ManyOrdersClient:
        def get_buyer_order_list(self, **kwargs):
            page = kwargs["page"]
            page_size = kwargs["page_size"]
            start = (page - 1) * page_size
            orders = [
                {
                    "baseInfo": {
                        "idOfStr": f"8888888888888{index:05d}",
                        "status": "success",
                        "createTime": "20260828142334000+0800",
                    },
                    "productItems": [{"subItemIDString": f"line-{index}", "name": "商品", "quantity": 1}],
                }
                for index in range(start, min(start + page_size, 120))
            ]
            return {"result": orders, "totalRecord": 120}

        def get_buyer_view(self, order_id: str):
            return {"result": {"nativeLogistics": {"logisticsItems": []}}}

    result = sync_account(
        database,
        APP,
        ACCOUNT,
        client=ManyOrdersClient(),
        page_size=20,
        max_pages=6,
    )
    assert result["status"] == "OK"
    assert result["orders"] == 120
    assert result["created"] == 120
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM purchase_orders").fetchone()["c"] == 120
        assert connection.execute(
            "SELECT COUNT(*) AS c FROM sync_batches WHERE worker_id = 'ali1688-api'"
        ).fetchone()["c"] == 2


def test_server_fails_closed_when_api_is_enabled_without_accounts(tmp_path) -> None:
    settings = Settings(
        database_path=tmp_path / "db" / "arrival.db",
        media_dir=tmp_path / "media",
        session_secret="test-session-secret-that-is-long-enough",
        bootstrap_admin_password="correct horse battery staple",
        ali1688_api_enabled=True,
        ali1688_config_path=tmp_path / "missing.json",
    )
    with pytest.raises(Ali1688ConfigError, match="no authorized accounts"):
        with TestClient(create_app(settings)):
            pass


def test_server_initializes_each_configured_account_without_network_when_scheduler_is_off(
    tmp_path,
) -> None:
    secret_path = tmp_path / "ali1688.json"
    secret_path.write_text(
        json.dumps(
            {
                "apps": [
                    {
                        "app_key": "app-123",
                        "app_secret": "secret",
                        "accounts": [
                            {"account_key": "buyer-a", "access_token": "token-a"},
                            {"account_key": "buyer-b", "access_token": "token-b"},
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    secret_path.chmod(0o600)
    database_path = tmp_path / "db" / "arrival.db"
    settings = Settings(
        database_path=database_path,
        media_dir=tmp_path / "media",
        session_secret="test-session-secret-that-is-long-enough",
        bootstrap_admin_password="correct horse battery staple",
        ali1688_api_enabled=True,
        ali1688_config_path=secret_path,
        ali1688_sync_interval_seconds=0,
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 200
    database = Database(database_path)
    with database.connect() as connection:
        rows = connection.execute(
            "SELECT account_key FROM ali1688_sync_state ORDER BY account_key"
        ).fetchall()
    assert [row["account_key"] for row in rows] == ["buyer-a", "buyer-b"]
