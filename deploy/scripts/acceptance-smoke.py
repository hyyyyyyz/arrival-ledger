#!/usr/bin/env python3
"""Run a synthetic end-to-end acceptance check against an isolated deployment.

Credentials and the worker token are read from environment variables and are
never printed.  By default the script refuses non-loopback URLs so it cannot
accidentally add synthetic records to production.
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any


JPEG_BYTES = b"\xff\xd8\xff\xe0arrival-ledger-acceptance-image\xff\xd9"


class AcceptanceError(RuntimeError):
    pass


class Client:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> tuple[int, dict[str, Any] | bytes, dict[str, str]]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers=headers or {},
        )
        try:
            response = self.opener.open(request, timeout=20)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            status = response.status
            payload = response.read()
            response_headers = {key.lower(): value for key, value in response.headers.items()}
        if status not in expected:
            safe_detail = payload[:300].decode("utf-8", errors="replace")
            raise AcceptanceError(
                f"{method} {path} returned {status}, expected {expected}: {safe_detail}"
            )
        content_type = response_headers.get("content-type", "")
        if "application/json" in content_type:
            return status, json.loads(payload), response_headers
        return status, payload, response_headers

    def json_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        merged_headers = {"Content-Type": "application/json", **(headers or {})}
        status, body, response_headers = self.request(
            method,
            path,
            body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=merged_headers,
            expected=expected,
        )
        if not isinstance(body, dict):
            raise AcceptanceError(f"{method} {path} did not return a JSON object")
        return status, body, response_headers


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise AcceptanceError(f"required environment variable is missing: {name}")
    return value


def identifiers(run_id: str) -> dict[str, str]:
    digest = hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:14].upper()
    return {
        "batch_id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"arrival-ledger/{run_id}")),
        "order_id": f"ACCEPTANCE-{digest}",
        "tracking_no": f"ACCEPT{digest}",
        "event_id": f"acceptance-photo-{digest.lower()}",
    }


def login(client: Client, username: str, password: str) -> None:
    status, payload, headers = client.json_request(
        "POST",
        "/api/auth/login",
        {"username": username, "password": password},
    )
    if status != 200 or payload.get("user", {}).get("username") != username:
        raise AcceptanceError("login response did not contain the expected user")
    cookie = headers.get("set-cookie", "").lower()
    if "httponly" not in cookie or "samesite=lax" not in cookie:
        raise AcceptanceError("session cookie is missing HttpOnly or SameSite=Lax")


def multipart_body(fields: dict[str, str], photo: bytes) -> tuple[bytes, str]:
    boundary = f"arrival-ledger-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    chunks.extend(
        [
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="photo"; filename="acceptance.jpg"\r\n',
            b"Content-Type: image/jpeg\r\n\r\n",
            photo,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def find_records(client: Client, ids: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
    query = urllib.parse.urlencode({"query": ids["order_id"], "limit": 20})
    _, orders, _ = client.request("GET", f"/api/orders?{query}")
    if not isinstance(orders, dict) or orders.get("total") != 1:
        raise AcceptanceError("synthetic order was not returned by the order list")
    order = orders["items"][0]
    if order.get("platform_order_id") != ids["order_id"]:
        raise AcceptanceError("order list returned the wrong synthetic order")

    _, receipts, _ = client.request("GET", "/api/receipts?limit=100")
    if not isinstance(receipts, dict):
        raise AcceptanceError("receipt list did not return a JSON object")
    matches = [
        item for item in receipts.get("items", [])
        if item.get("client_event_id") == ids["event_id"]
    ]
    if len(matches) != 1:
        raise AcceptanceError("synthetic receipt was not returned exactly once")
    receipt = matches[0]
    return order, receipt


def verify_state(client: Client, ids: dict[str, str]) -> dict[str, Any]:
    order, receipt = find_records(client, ids)
    order_matches = receipt.get("order_matches", [])
    if len(order_matches) != 1 or order_matches[0].get("platform_order_id") != ids["order_id"]:
        raise AcceptanceError("receipt was not matched to the synthetic order")
    if receipt.get("tracking_no") != ids["tracking_no"]:
        raise AcceptanceError("receipt tracking number changed")

    _, stats, _ = client.request("GET", "/api/dashboard/stats")
    if not isinstance(stats, dict):
        raise AcceptanceError("dashboard did not return a JSON object")
    expected_stats = {
        "total_orders": 1,
        "arrival_photos": 1,
        "matched_orders": 1,
        "linked_orders": 1,
        "pending_orders": 0,
        "unlinked_orders": 0,
        "account_count": 1,
    }
    for key, expected in expected_stats.items():
        if stats.get(key) != expected:
            raise AcceptanceError(
                f"dashboard {key}={stats.get(key)!r}, expected {expected!r}"
            )

    photo_metadata = receipt.get("photo")
    declared_photo_url = (
        photo_metadata.get("url") if isinstance(photo_metadata, dict) else None
    )
    photo_path = receipt.get("photo_url") or declared_photo_url
    if not isinstance(photo_path, str) or not photo_path.startswith("/api/"):
        raise AcceptanceError("receipt did not contain a same-origin photo URL")
    _, photo, headers = client.request("GET", photo_path)
    if photo != JPEG_BYTES or not headers.get("content-type", "").startswith("image/jpeg"):
        raise AcceptanceError("persisted photo bytes or content type did not match")

    return {
        "order_id": order["platform_order_id"],
        "receipt_id": receipt["id"],
        "dashboard": {key: stats[key] for key in expected_stats},
    }


def seed(client: Client, ids: dict[str, str], worker_token: str) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    payload = {
        "schema_version": 1,
        "batch_id": ids["batch_id"],
        "worker_id": "acceptance-worker",
        "platform": "1688",
        "platform_account_key": "acceptance-account",
        "platform_account_label": "隔离验收账号",
        "started_at": now,
        "finished_at": now,
        "cursor_before": None,
        "cursor_after": None,
        "mode": "commit",
        "orders": [
            {
                "platform_order_id": ids["order_id"],
                "ordered_at": now,
                "status": "SHIPPED",
                "shop_name": "隔离验收店铺",
                "items": [
                    {
                        "item_key": "acceptance-item-1",
                        "title": "隔离验收商品",
                        "sku_text": "规格：测试",
                        "quantity": 1,
                        "unit_price": "1.00",
                    }
                ],
                "packages": [
                    {
                        "courier": "验收快递",
                        "tracking_no": ids["tracking_no"],
                        "status": "SHIPPED",
                    }
                ],
                "observed_at": now,
            }
        ],
    }
    _, result, _ = client.json_request(
        "POST",
        "/api/sync/v1/batches",
        payload,
        headers={
            "Authorization": f"Bearer {worker_token}",
            "Idempotency-Key": ids["batch_id"],
        },
    )
    if result.get("created") != 1 or result.get("errors") != []:
        raise AcceptanceError("synthetic sync batch was not committed cleanly")

    fields = {
        "client_event_id": ids["event_id"],
        "captured_at": now,
        "device_id": "acceptance-device",
        "tracking_no": ids["tracking_no"],
        "input_method": "PHOTO_CAPTURE",
    }
    body, content_type = multipart_body(fields, JPEG_BYTES)
    status, receipt_result, _ = client.request(
        "POST",
        "/api/receipts",
        body=body,
        headers={"Content-Type": content_type},
        expected=(201,),
    )
    if status != 201 or not isinstance(receipt_result, dict) or not receipt_result.get("created"):
        raise AcceptanceError("synthetic receipt was not created")

    replay_body, replay_content_type = multipart_body(fields, JPEG_BYTES)
    replay_status, replay, _ = client.request(
        "POST",
        "/api/receipts",
        body=replay_body,
        headers={"Content-Type": replay_content_type},
        expected=(200,),
    )
    if replay_status != 200 or not isinstance(replay, dict) or not replay.get("idempotent_replay"):
        raise AcceptanceError("receipt idempotency replay check failed")
    return verify_state(client, ids)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("seed", "verify"))
    args = parser.parse_args()

    base_url = os.getenv("ARRIVAL_ACCEPTANCE_BASE_URL", "http://127.0.0.1:8877")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise AcceptanceError("acceptance checks only run against a loopback URL")

    username = require_env("ARRIVAL_ACCEPTANCE_USERNAME")
    password = require_env("ARRIVAL_ACCEPTANCE_PASSWORD")
    run_id = require_env("ARRIVAL_ACCEPTANCE_RUN_ID")
    ids = identifiers(run_id)
    client = Client(base_url)
    login(client, username, password)

    if args.mode == "seed":
        result = seed(client, ids, require_env("ARRIVAL_ACCEPTANCE_WORKER_TOKEN"))
    else:
        result = verify_state(client, ids)
    print(json.dumps({"status": "ok", "mode": args.mode, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AcceptanceError as exc:
        print(f"acceptance failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
