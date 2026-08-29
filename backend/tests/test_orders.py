from __future__ import annotations

from copy import deepcopy

from fastapi.testclient import TestClient

from test_sync_api import batch_payload, post_batch


def make_order(
    platform_order_id: str,
    *,
    ordered_at: str | None,
    shop_name: str,
    title: str = "示例商品",
    sku_text: str | None = "标准规格",
    tracking_no: str | None = None,
) -> dict:
    order = deepcopy(batch_payload()["orders"][0])
    order["platform_order_id"] = platform_order_id
    order["ordered_at"] = ordered_at
    order["shop_name"] = shop_name
    order["items"][0]["item_key"] = f"item-{platform_order_id}"
    order["items"][0]["title"] = title
    order["items"][0]["sku_text"] = sku_text
    order["packages"] = (
        [
            {
                "courier": "圆通速递",
                "tracking_no": tracking_no,
                "status": "SHIPPED",
            }
        ]
        if tracking_no is not None
        else []
    )
    return order


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
            "captured_at": "2026-08-29T10:20:30+08:00",
            "device_id": "orders-test-device",
            "tracking_no": tracking_no,
            "input_method": "PHOTO_CAPTURE",
        },
        files={"photo": (f"{event_id}.jpg", photo, "image/jpeg")},
    )
    assert response.status_code == 201
    return response.json()["receipt"]


def test_orders_require_authentication(client: TestClient) -> None:
    assert client.get("/api/orders").status_code == 401


def test_orders_sort_and_paginate_deterministically(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    payload = batch_payload("b-orders-pagination-0001")
    payload["orders"] = [
        make_order(
            "order-old",
            ordered_at="2026-08-01T01:00:00.000Z",
            shop_name="旧订单店铺",
        ),
        make_order(
            "order-new-a",
            ordered_at="2026-08-03T01:00:00.000Z",
            shop_name="新订单甲店铺",
        ),
        make_order(
            "order-new-b",
            ordered_at="2026-08-03T01:00:00.000Z",
            shop_name="新订单乙店铺",
        ),
        make_order("order-no-date", ordered_at=None, shop_name="无日期店铺"),
    ]
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    first = authenticated_client.get("/api/orders", params={"limit": 2}).json()
    assert first["total"] == 4
    assert first["limit"] == 2
    assert first["offset"] == 0
    assert first["last_synced_at"] is not None
    assert [item["platform_order_id"] for item in first["items"]] == [
        "order-new-b",
        "order-new-a",
    ]
    assert all(item["id"].isdigit() for item in first["items"])

    second = authenticated_client.get(
        "/api/orders", params={"limit": 2, "offset": 2}
    ).json()
    assert second["total"] == 4
    assert second["offset"] == 2
    assert [item["platform_order_id"] for item in second["items"]] == [
        "order-old",
        "order-no-date"
    ]

    beyond = authenticated_client.get(
        "/api/orders", params={"limit": 20, "offset": 99}
    ).json()
    assert beyond["total"] == 4
    assert beyond["items"] == []
    assert beyond["last_synced_at"] == first["last_synced_at"]

    assert authenticated_client.get("/api/orders", params={"limit": 0}).status_code == 422
    assert authenticated_client.get("/api/orders", params={"limit": 101}).status_code == 422
    assert authenticated_client.get("/api/orders", params={"offset": -1}).status_code == 422
    assert (
        authenticated_client.get(
            "/api/orders", params={"platform": "taobao"}
        ).status_code
        == 422
    )


def test_orders_report_oldest_successful_sync_across_selected_accounts(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    assert authenticated_client.get("/api/orders").json()["last_synced_at"] is None

    pdd = batch_payload("b-orders-freshness-pdd-0001")
    assert post_batch(authenticated_client, pdd, sync_headers).status_code == 200
    pdd_synced_at = authenticated_client.get(
        "/api/orders", params={"platform": "pdd"}
    ).json()["last_synced_at"]
    assert pdd_synced_at is not None

    ali = batch_payload(
        "b-orders-freshness-ali-0001",
        platform="1688",
        platform_account_key="1688-freshness",
        platform_account_label="1688新鲜度测试",
    )
    assert post_batch(authenticated_client, ali, sync_headers).status_code == 200
    with authenticated_client.app.state.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO ali1688_sync_state(
                account_key, cursor, last_success_at, last_error_at,
                last_error_code, last_error_message, last_count, updated_at
            ) VALUES (?, NULL, ?, NULL, NULL, NULL, 0, ?)
            """,
            (
                "1688-freshness",
                "2099-01-01T00:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
            ),
        )
        connection.execute(
            """
            INSERT INTO ali1688_sync_runs(
                account_key, run_id, status, started_at, finished_at,
                count, error_code, error_message
            ) VALUES (?, ?, 'OK', ?, ?, 0, NULL, NULL)
            """,
            (
                "1688-freshness",
                "freshness-ok-run",
                "2099-01-01T00:00:00.000Z",
                "2099-01-01T00:00:00.000Z",
            ),
        )
        connection.execute(
            """
            INSERT INTO ali1688_sync_runs(
                account_key, run_id, status, started_at, finished_at,
                count, error_code, error_message
            ) VALUES (?, ?, 'PARTIAL', ?, ?, 1, 'PAGE_CAP_REACHED', NULL)
            """,
            (
                "1688-freshness",
                "freshness-partial-run",
                "2100-01-01T00:00:00.000Z",
                "2100-01-01T00:00:00.000Z",
            ),
        )
        connection.commit()

    assert authenticated_client.get(
        "/api/orders", params={"platform": "1688"}
    ).json()["last_synced_at"] == "2099-01-01T00:00:00Z"
    assert authenticated_client.get("/api/orders").json()["last_synced_at"] == pdd_synced_at

    with authenticated_client.app.state.database.connect() as connection:
        connection.execute(
            """
            INSERT INTO ali1688_sync_state(
                account_key, cursor, last_success_at, last_error_at,
                last_error_code, last_error_message, last_count, updated_at
            ) VALUES ('1688-never-synced', NULL, NULL, ?, 'SYNC_FAILED', ?, 0, ?)
            """,
            (
                "2026-08-30T00:00:00.000Z",
                "1688 sync failed",
                "2026-08-30T00:00:00.000Z",
            ),
        )
        connection.commit()

    assert authenticated_client.get(
        "/api/orders", params={"platform": "1688"}
    ).json()["last_synced_at"] is None
    assert authenticated_client.get("/api/orders").json()["last_synced_at"] is None
    assert authenticated_client.get(
        "/api/orders", params={"platform": "pdd"}
    ).json()["last_synced_at"] == pdd_synced_at


def test_orders_search_and_platform_filter(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    pdd = batch_payload(
        "b-orders-search-0001",
        platform_account_label="采购一号",
    )
    pdd["orders"] = [
        make_order(
            "PDD-SEARCH-001",
            ordered_at="2026-08-10T01:00:00.000Z",
            shop_name="星光测试店",
            title="蓝色收纳箱",
            sku_text="超大号",
            tracking_no="YT-ABC-9988",
        ),
        make_order(
            "PDD-OTHER-002",
            ordered_at="2026-08-09T01:00:00.000Z",
            shop_name="店铺A",
            title="普通商品",
        ),
    ]
    assert post_batch(authenticated_client, pdd, sync_headers).status_code == 200

    ali = batch_payload(
        "b-orders-search-0002",
        platform="1688",
        platform_account_key="1688-orders",
        platform_account_label="1688主账号",
    )
    ali["orders"] = [
        make_order(
            "ALI-SEARCH-001",
            ordered_at="2026-08-11T01:00:00.000Z",
            shop_name="工业品店",
            title="工业胶带",
            sku_text="黑色",
            tracking_no="ZTO-1688-001",
        )
    ]
    assert post_batch(authenticated_client, ali, sync_headers).status_code == 200

    searches = {
        "星光": {"PDD-SEARCH-001"},
        "超大号": {"PDD-SEARCH-001"},
        "yt abc 9988": {"PDD-SEARCH-001"},
        "采购一号": {"PDD-SEARCH-001", "PDD-OTHER-002"},
        "店铺A": {"PDD-OTHER-002"},
        "工业胶带": {"ALI-SEARCH-001"},
    }
    for query, expected_order_ids in searches.items():
        body = authenticated_client.get(
            "/api/orders", params={"query": query}
        ).json()
        assert body["total"] == len(expected_order_ids)
        assert {item["platform_order_id"] for item in body["items"]} == expected_order_ids

    pdd_only = authenticated_client.get(
        "/api/orders", params={"platform": "pdd"}
    ).json()
    assert pdd_only["total"] == 2
    assert {item["platform"] for item in pdd_only["items"]} == {"pdd"}

    combined = authenticated_client.get(
        "/api/orders", params={"platform": "pdd", "query": "工业胶带"}
    ).json()
    assert combined["total"] == 0
    assert combined["items"] == []


def test_orders_arrival_status_filters_before_pagination_and_combine(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
    jpeg_bytes: bytes,
) -> None:
    pdd = batch_payload(
        "b-orders-arrival-filter-0001",
        platform_account_label="拼多多采购",
    )
    pdd_received = make_order(
        "PDD-RECEIVED",
        ordered_at="2026-08-20T09:00:00.000Z",
        shop_name="跨页已收店铺",
        title="跨页已收商品",
        tracking_no="ARRIVED-PDD-001",
    )
    partial = make_order(
        "PDD-PARTIAL",
        ordered_at="2026-08-19T09:00:00.000Z",
        shop_name="部分到货店铺",
    )
    partial["packages"] = [
        {
            "courier": "圆通速递",
            "tracking_no": "PARTIAL-ARRIVED-001",
            "status": "SHIPPED",
        },
        {
            "courier": "圆通速递",
            "tracking_no": "PARTIAL-PENDING-002",
            "status": "SHIPPED",
        },
    ]
    candidate_a = make_order(
        "PDD-CANDIDATE-A",
        ordered_at="2026-08-18T09:00:00.000Z",
        shop_name="候选店铺甲",
        tracking_no="SHARED-REVIEW-001",
    )
    candidate_b = make_order(
        "PDD-CANDIDATE-B",
        ordered_at="2026-08-17T09:00:00.000Z",
        shop_name="候选店铺乙",
        tracking_no="SHARED-REVIEW-001",
    )
    pending_with_package = make_order(
        "PDD-PENDING-PACKAGE",
        ordered_at="2026-08-16T09:00:00.000Z",
        shop_name="待收店铺",
        tracking_no="PENDING-PDD-001",
    )
    pending_without_package = make_order(
        "PDD-PENDING-NO-PACKAGE",
        ordered_at="2026-08-15T09:00:00.000Z",
        shop_name="未发货店铺",
    )
    cancelled = make_order(
        "PDD-CANCELLED",
        ordered_at="2026-08-14T09:00:00.000Z",
        shop_name="已关闭店铺",
    )
    cancelled["status"] = "CANCELLED"
    refunded = make_order(
        "PDD-REFUNDED",
        ordered_at="2026-08-13T09:00:00.000Z",
        shop_name="已退款店铺",
    )
    refunded["status"] = "REFUNDED"
    pdd["orders"] = [
        pdd_received,
        partial,
        candidate_a,
        candidate_b,
        pending_with_package,
        pending_without_package,
        cancelled,
        refunded,
    ]
    assert post_batch(authenticated_client, pdd, sync_headers).status_code == 200

    ali = batch_payload(
        "b-orders-arrival-filter-0002",
        platform="1688",
        platform_account_key="1688-arrival-filter",
        platform_account_label="1688采购",
    )
    ali["orders"] = [
        make_order(
            "ALI-RECEIVED",
            ordered_at="2026-08-21T09:00:00.000Z",
            shop_name="跨页已收店铺",
            title="跨页已收商品",
            tracking_no="ARRIVED-ALI-001",
        )
    ]
    assert post_batch(authenticated_client, ali, sync_headers).status_code == 200

    for index, tracking_no in enumerate(
        (
            "ARRIVED-PDD-001",
            "ARRIVED-ALI-001",
            "PARTIAL-ARRIVED-001",
            "SHARED-REVIEW-001",
        ),
        start=1,
    ):
        upload_receipt(
            authenticated_client,
            event_id=f"orders-arrival-filter-photo-{index:04d}",
            tracking_no=tracking_no,
            photo=jpeg_bytes + bytes([index]),
        )

    expected = {
        "all": {
            "PDD-RECEIVED",
            "PDD-PARTIAL",
            "PDD-CANDIDATE-A",
            "PDD-CANDIDATE-B",
            "PDD-PENDING-PACKAGE",
            "PDD-PENDING-NO-PACKAGE",
            "PDD-CANCELLED",
            "PDD-REFUNDED",
            "ALI-RECEIVED",
        },
        "received": {"PDD-RECEIVED", "ALI-RECEIVED"},
        "review": {"PDD-PARTIAL", "PDD-CANDIDATE-A", "PDD-CANDIDATE-B"},
        "pending": {"PDD-PENDING-PACKAGE", "PDD-PENDING-NO-PACKAGE"},
    }
    for arrival_status, expected_ids in expected.items():
        body = authenticated_client.get(
            "/api/orders", params={"arrival_status": arrival_status, "limit": 100}
        ).json()
        assert body["total"] == len(expected_ids)
        assert {item["platform_order_id"] for item in body["items"]} == expected_ids

    first_received = authenticated_client.get(
        "/api/orders", params={"arrival_status": "received", "limit": 1}
    ).json()
    second_received = authenticated_client.get(
        "/api/orders",
        params={"arrival_status": "received", "limit": 1, "offset": 1},
    ).json()
    beyond_received = authenticated_client.get(
        "/api/orders",
        params={"arrival_status": "received", "limit": 1, "offset": 2},
    ).json()
    assert first_received["total"] == second_received["total"] == 2
    assert len(first_received["items"]) == len(second_received["items"]) == 1
    assert first_received["items"][0]["platform_order_id"] != (
        second_received["items"][0]["platform_order_id"]
    )
    assert beyond_received["total"] == 2
    assert beyond_received["items"] == []

    combined = authenticated_client.get(
        "/api/orders",
        params={
            "arrival_status": "received",
            "platform": "1688",
            "query": "跨页已收商品",
        },
    ).json()
    assert combined["total"] == 1
    assert combined["items"][0]["platform_order_id"] == "ALI-RECEIVED"

    excluded_by_status = authenticated_client.get(
        "/api/orders",
        params={"arrival_status": "pending", "query": "已关闭店铺"},
    ).json()
    assert excluded_by_status["total"] == 0
    assert excluded_by_status["items"] == []

    assert (
        authenticated_client.get(
            "/api/orders", params={"arrival_status": "unknown"}
        ).status_code
        == 422
    )


def test_orders_keep_same_platform_order_id_distinct_across_accounts(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
) -> None:
    for index, account_key in enumerate(
        ("pdd-primary", "pdd-secondary"),
        start=1,
    ):
        payload = batch_payload(
            f"b-orders-account-000{index}",
            platform_account_key=account_key,
        )
        payload["orders"] = [
            make_order(
                "SAME-PLATFORM-ORDER",
                ordered_at=f"2026-08-1{index}T01:00:00.000Z",
                shop_name=f"账号{index}店铺",
            )
        ]
        assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    body = authenticated_client.get(
        "/api/orders", params={"query": "SAME-PLATFORM-ORDER"}
    ).json()

    assert body["total"] == 2
    assert len({item["id"] for item in body["items"]}) == 2
    account_labels = {item["account_label"] for item in body["items"]}
    assert len(account_labels) == 2
    assert all(
        label.startswith("账号 ") and label.removeprefix("账号 ").isdigit()
        for label in account_labels
    )
    assert all(item["platform"] == "pdd" for item in body["items"])
    assert all(item["platform_order_id"] == "SAME-PLATFORM-ORDER" for item in body["items"])

    by_account_key = authenticated_client.get(
        "/api/orders", params={"query": "pdd-secondary"}
    ).json()
    assert by_account_key["total"] == 1
    assert by_account_key["items"][0]["shop_name"] == "账号2店铺"


def test_orders_return_items_packages_and_canonical_arrival_counts(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
    jpeg_bytes: bytes,
) -> None:
    payload = batch_payload("b-orders-details-0001")
    order = make_order(
        "ORDER-WITH-DETAILS",
        ordered_at="2026-08-20T01:00:00.000Z",
        shop_name="多包裹店铺",
    )
    order["items"] = [
        {
            "item_key": "detail-item-1",
            "title": "商品甲",
            "sku_text": "红色",
            "quantity": 2,
            "unit_price": "10.50",
        },
        {
            "item_key": "detail-item-2",
            "title": "商品乙",
            "sku_text": None,
            "quantity": 3,
            "unit_price": None,
        },
    ]
    order["packages"] = [
        {"courier": "顺丰速运", "tracking_no": "SF-DETAIL-001", "status": "SHIPPED"},
        {"courier": "顺丰备用", "tracking_no": "sf detail 001", "status": "IN_TRANSIT"},
        {"courier": None, "tracking_no": "ZTO-DETAIL-002", "status": None},
    ]
    payload["orders"] = [order]
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200
    with authenticated_client.app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS c FROM packages").fetchone()["c"] == 3

    before = authenticated_client.get("/api/orders").json()["items"][0]
    assert before["items"] == [
        {
            "title": "商品甲",
            "sku_text": "红色",
            "quantity": "2",
            "unit_price": "10.50",
        },
        {
            "title": "商品乙",
            "sku_text": None,
            "quantity": "3",
            "unit_price": None,
        },
    ]
    assert before["package_count"] == 2
    assert before["arrived_package_count"] == 0
    assert before["candidate_package_count"] == 0
    assert before["arrival_photo_count"] == 0
    assert before["candidate_photo_count"] == 0
    assert len(before["packages"]) == 2
    assert before["packages"][0]["courier"] == "顺丰备用"
    assert before["packages"][0]["package_status"] == "IN_TRANSIT"
    assert [package["arrival_status"] for package in before["packages"]] == [
        "PENDING",
        "PENDING",
    ]
    assert [package["arrived"] for package in before["packages"]] == [False, False]

    upload_receipt(
        authenticated_client,
        event_id="orders-detail-photo-0001",
        tracking_no="sf detail 001",
        photo=jpeg_bytes,
    )
    after_first = authenticated_client.get("/api/orders").json()["items"][0]
    assert after_first["arrived_package_count"] == 1
    assert after_first["candidate_package_count"] == 0
    assert after_first["arrival_photo_count"] == 1
    assert after_first["candidate_photo_count"] == 0
    assert [package["arrival_status"] for package in after_first["packages"]] == [
        "ARRIVED",
        "PENDING",
    ]
    assert [package["arrived"] for package in after_first["packages"]] == [True, False]

    duplicate = upload_receipt(
        authenticated_client,
        event_id="orders-detail-photo-0002",
        tracking_no="SF-DETAIL-001",
        photo=jpeg_bytes + b"duplicate",
    )
    assert duplicate["is_duplicate"] is True

    failed = upload_receipt(
        authenticated_client,
        event_id="orders-detail-photo-failed",
        tracking_no="ZTO-DETAIL-002",
        photo=jpeg_bytes + b"failed",
    )
    with authenticated_client.app.state.database.connect() as connection:
        connection.execute(
            "UPDATE receipt_events SET evidence_status = 'FAILED' WHERE id = ?",
            (failed["id"],),
        )
        connection.commit()

    after_duplicate = authenticated_client.get("/api/orders").json()["items"][0]
    assert after_duplicate["packages"] == after_first["packages"]
    assert after_duplicate["arrived_package_count"] == 1
    assert after_duplicate["arrival_photo_count"] == 1


def test_orders_treat_tracking_linked_to_multiple_orders_as_candidate(
    authenticated_client: TestClient,
    sync_headers: dict[str, str],
    jpeg_bytes: bytes,
) -> None:
    shared_tracking = "SHARED-CANDIDATE-01"
    payload = batch_payload("b-orders-candidate-0001")
    payload["orders"] = [
        make_order(
            "CANDIDATE-ORDER-A",
            ordered_at="2026-08-21T01:00:00.000Z",
            shop_name="候选店铺甲",
            tracking_no=shared_tracking,
        ),
        make_order(
            "CANDIDATE-ORDER-B",
            ordered_at="2026-08-22T01:00:00.000Z",
            shop_name="候选店铺乙",
            tracking_no=shared_tracking,
        ),
    ]
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    upload_receipt(
        authenticated_client,
        event_id="orders-candidate-photo-0001",
        tracking_no="shared candidate 01",
        photo=jpeg_bytes,
    )
    before_duplicate = authenticated_client.get(
        "/api/orders", params={"query": shared_tracking}
    ).json()
    assert before_duplicate["total"] == 2
    for order in before_duplicate["items"]:
        assert order["package_count"] == 1
        assert order["arrived_package_count"] == 0
        assert order["candidate_package_count"] == 1
        assert order["arrival_photo_count"] == 0
        assert order["candidate_photo_count"] == 1
        assert order["packages"] == [
            {
                "courier": "圆通速递",
                "tracking_no": shared_tracking,
                "package_status": "SHIPPED",
                "arrival_status": "CANDIDATE",
                "arrived": False,
            }
        ]

    duplicate = upload_receipt(
        authenticated_client,
        event_id="orders-candidate-photo-0002",
        tracking_no=shared_tracking,
        photo=jpeg_bytes + b"duplicate",
    )
    assert duplicate["is_duplicate"] is True
    after_duplicate = authenticated_client.get(
        "/api/orders", params={"query": shared_tracking}
    ).json()
    assert after_duplicate == before_duplicate
