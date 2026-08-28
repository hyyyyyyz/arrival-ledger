from __future__ import annotations

from fastapi.testclient import TestClient

from test_sync_api import batch_payload, post_batch


def upload_receipt(
    authenticated_client: TestClient,
    tracking_no: str,
    event_id: str,
    jpeg_bytes: bytes,
) -> dict:
    response = authenticated_client.post(
        "/api/receipts",
        data={
            "client_event_id": event_id,
            "captured_at": "2026-08-13T10:20:30+08:00",
            "device_id": "wechat-test-device",
            "tracking_no": tracking_no,
            "input_method": "PHOTO_CAPTURE",
        },
        files={"photo": ("parcel.jpg", jpeg_bytes, "image/jpeg")},
    )
    assert response.status_code == 201
    return response.json()["receipt"]


def test_receipt_order_match_by_tracking(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    payload = batch_payload("b-receipt-match-0001")
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    receipt = upload_receipt(
        authenticated_client, "SF1234567890000", "receipt-match-0001", jpeg_bytes
    )
    matches = receipt["order_matches"]
    assert len(matches) == 1
    match = matches[0]
    assert match["platform"] == "pdd"
    assert match["platform_order_id"] == "260813-0001"
    assert match["shop_name"] == "测试店铺"
    assert match["courier"] == "顺丰速运"
    assert match["tracking_no"] == "SF1234567890000"
    assert len(match["items"]) == 1
    assert match["items"][0]["title"] == "示例商品"
    assert match["items"][0]["quantity"] == "2"


def test_unmatched_receipt_has_empty_matches(
    authenticated_client: TestClient, jpeg_bytes: bytes
) -> None:
    receipt = upload_receipt(
        authenticated_client, "SF0000000000000", "receipt-unmatched-0001", jpeg_bytes
    )
    assert receipt["order_matches"] == []


def test_cross_platform_tracking_matches_all_orders(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    pdd = batch_payload("b-xplat-0001")
    assert post_batch(authenticated_client, pdd, sync_headers).status_code == 200

    ali = batch_payload("b-xplat-0002", platform="1688", platform_account_key="1688-main")
    ali["orders"][0]["platform_order_id"] = "1688-9999"
    ali["orders"][0]["items"][0]["title"] = "1688 示例商品"
    assert post_batch(authenticated_client, ali, sync_headers).status_code == 200

    receipt = upload_receipt(
        authenticated_client, "SF1234567890000", "receipt-xplat-0001", jpeg_bytes
    )
    matches = receipt["order_matches"]
    assert len(matches) == 2
    platforms = {match["platform"] for match in matches}
    assert platforms == {"pdd", "1688"}
    assert all(match["confidence"] == "CANDIDATE" for match in matches)


def test_same_platform_order_id_from_different_accounts_stays_distinct(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    first = batch_payload(
        "b-same-id-accounts-0001",
        platform_account_label="拼多多一号账号",
    )
    first["orders"][0]["shop_name"] = "账号一店铺"
    assert post_batch(authenticated_client, first, sync_headers).status_code == 200

    second = batch_payload(
        "b-same-id-accounts-0002",
        platform_account_key="pdd-secondary",
        platform_account_label="拼多多二号账号",
    )
    second["orders"][0]["shop_name"] = "账号二店铺"
    assert post_batch(authenticated_client, second, sync_headers).status_code == 200

    receipt = upload_receipt(
        authenticated_client,
        "SF1234567890000",
        "receipt-same-id-accounts-0001",
        jpeg_bytes,
    )

    matches = receipt["order_matches"]
    assert len(matches) == 2
    assert len({match["order_id"] for match in matches}) == 2
    assert all(match["order_id"].isdigit() for match in matches)
    assert {match["account_label"] for match in matches} == {
        "拼多多一号账号",
        "拼多多二号账号",
    }
    assert {match["shop_name"] for match in matches} == {"账号一店铺", "账号二店铺"}
    assert all(match["platform_order_id"] == "260813-0001" for match in matches)
    assert all(match["confidence"] == "CANDIDATE" for match in matches)


def test_single_match_has_exact_confidence(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    payload = batch_payload("b-exact-match-0001")
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    receipt = upload_receipt(
        authenticated_client, "SF1234567890000", "receipt-exact-0001", jpeg_bytes
    )
    matches = receipt["order_matches"]
    assert len(matches) == 1
    assert matches[0]["confidence"] == "EXACT"


def test_multi_item_order_match_lists_all_items(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    payload = batch_payload("b-multi-item-match-0001")
    payload["orders"][0]["items"] = [
        {"item_key": "i-1", "title": "商品甲", "sku_text": "A", "quantity": 2, "unit_price": None},
        {"item_key": "i-2", "title": "商品乙", "sku_text": "B", "quantity": 3, "unit_price": None},
    ]
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    receipt = upload_receipt(
        authenticated_client, "SF1234567890000", "receipt-multi-item-0001", jpeg_bytes
    )
    match = receipt["order_matches"][0]
    assert len(match["items"]) == 2
    assert [item["title"] for item in match["items"]] == ["商品甲", "商品乙"]


def test_platform_signed_status_does_not_auto_receive(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    payload = batch_payload("b-signed-0001")
    payload["orders"][0]["status"] = "COMPLETED"
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    with authenticated_client.app.state.database.connect() as connection:
        count = connection.execute("SELECT COUNT(*) AS c FROM receipt_events").fetchone()["c"]
        assert count == 0

    receipt = upload_receipt(
        authenticated_client, "SF1234567890000", "receipt-signed-0001", jpeg_bytes
    )
    assert receipt["evidence_status"] == "READY"
    with authenticated_client.app.state.database.connect() as connection:
        count = connection.execute("SELECT COUNT(*) AS c FROM receipt_events").fetchone()["c"]
        assert count == 1


def test_matches_refresh_after_later_sync(
    authenticated_client: TestClient, sync_headers: dict[str, str], jpeg_bytes: bytes
) -> None:
    receipt = upload_receipt(
        authenticated_client, "SF1234567890000", "receipt-late-match-0001", jpeg_bytes
    )
    assert receipt["order_matches"] == []

    payload = batch_payload("b-late-match-0001")
    assert post_batch(authenticated_client, payload, sync_headers).status_code == 200

    listing = authenticated_client.get("/api/receipts").json()
    item = next(
        entry for entry in listing["items"] if entry["client_event_id"] == "receipt-late-match-0001"
    )
    assert len(item["order_matches"]) == 1
    assert item["order_matches"][0]["platform_order_id"] == "260813-0001"
