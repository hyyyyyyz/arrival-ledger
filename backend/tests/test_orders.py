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

    assert authenticated_client.get("/api/orders", params={"limit": 0}).status_code == 422
    assert authenticated_client.get("/api/orders", params={"limit": 101}).status_code == 422
    assert authenticated_client.get("/api/orders", params={"offset": -1}).status_code == 422
    assert (
        authenticated_client.get(
            "/api/orders", params={"platform": "taobao"}
        ).status_code
        == 422
    )


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
