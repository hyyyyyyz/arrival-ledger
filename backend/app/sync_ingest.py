from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SYNC_SCHEMA_VERSION = 1
SYNC_SOURCE = "WINDOWS_BROWSER"
SYNC_SOURCES = ("WINDOWS_BROWSER", "ALI1688_API")
SYNC_PLATFORMS = ("pdd", "1688")
SYNC_ORDER_STATUSES = (
    "PENDING",
    "PAID",
    "SHIPPED",
    "COMPLETED",
    "REFUNDED",
    "CANCELLED",
    "UNKNOWN",
)


class SyncOrderItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_key: str | None = Field(default=None, max_length=64)
    title: str = Field(min_length=1, max_length=300)
    sku_text: str | None = Field(default=None, max_length=200)
    quantity: int = Field(ge=1, le=999999)
    unit_price: str | None = Field(default=None, max_length=32)


class SyncPackageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    courier: str | None = Field(default=None, max_length=64)
    tracking_no: str = Field(min_length=1, max_length=64)
    status: str | None = Field(default=None, max_length=64)

    @field_validator("tracking_no")
    @classmethod
    def tracking_no_has_alnum(cls, value: str) -> str:
        if not re.search(r"[A-Za-z0-9]", value):
            raise ValueError("tracking_no must contain at least one letter or digit")
        return value


class SyncOrderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platform_order_id: str = Field(min_length=1, max_length=64)
    ordered_at: datetime | None = None
    status: Literal[
        "PENDING",
        "PAID",
        "SHIPPED",
        "COMPLETED",
        "REFUNDED",
        "CANCELLED",
        "UNKNOWN",
    ]
    shop_name: str | None = Field(default=None, max_length=128)
    items: list[SyncOrderItemIn] = Field(min_length=1, max_length=50)
    packages: list[SyncPackageIn] = Field(default_factory=list, max_length=20)
    observed_at: datetime

    @field_validator("platform_order_id")
    @classmethod
    def platform_order_id_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("ordered_at", "observed_at")
    @classmethod
    def require_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("must include a timezone offset")
        return value


class SyncBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    batch_id: str = Field(min_length=1, max_length=64)
    worker_id: str = Field(min_length=1, max_length=64)
    platform: Literal["pdd", "1688"]
    platform_account_key: str = Field(min_length=1, max_length=64)
    platform_account_label: str | None = Field(default=None, max_length=128)
    source: Literal["WINDOWS_BROWSER", "ALI1688_API"] = "WINDOWS_BROWSER"
    started_at: datetime
    finished_at: datetime
    cursor_before: str | None = Field(default=None, max_length=512)
    cursor_after: str | None = Field(default=None, max_length=512)
    mode: Literal["commit"]
    orders: list[SyncOrderIn] = Field(min_length=1, max_length=100)

    @field_validator("batch_id", "worker_id", "platform_account_key")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @field_validator("started_at", "finished_at")
    @classmethod
    def require_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("must include a timezone offset")
        return value

    @model_validator(mode="after")
    def finished_after_started(self) -> "SyncBatchIn":
        if self.finished_at < self.started_at:
            raise ValueError("finished_at must not be earlier than started_at")
        return self


class SyncBatchResponse(BaseModel):
    batch_id: str
    created: int
    updated: int
    skipped: int
    errors: list[str]
    cursor_accepted: bool


def normalize_tracking_no(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def normalize_courier(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().upper()


def normalize_title(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def item_identity(item_key: str | None, title: str, sku_text: str | None) -> str:
    if item_key is not None and item_key.strip():
        return item_key.strip()[:64]
    raw = f"{normalize_title(title)}\x1f{normalize_title(sku_text or '')}"
    return "fp:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def batch_counts_json(created: int, updated: int, skipped: int, errors: int) -> str:
    return json.dumps(
        {"created": created, "updated": updated, "skipped": skipped, "errors": errors},
        separators=(",", ":"),
        sort_keys=True,
    )


def parse_batch_counts(raw: str) -> dict[str, int]:
    return json.loads(raw)


def canonical_payload_digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def db_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def ingest_sync_batch(
    connection: sqlite3.Connection,
    payload: SyncBatchIn,
    payload_sha256: str,
    token_digest: str,
    now: str,
    *,
    manage_transaction: bool = True,
) -> dict[str, int]:
    created = 0
    updated = 0
    skipped = 0

    try:
        if manage_transaction:
            connection.execute("BEGIN IMMEDIATE")
        account_id = _upsert_platform_account_in_tx(connection, payload, now)
        for order in payload.orders:
            created, updated, skipped = _upsert_order(
                connection,
                account_id,
                order,
                now,
                created,
                updated,
                skipped,
                payload.source,
            )
        counts = {"created": created, "updated": updated, "skipped": skipped, "errors": 0}
        connection.execute(
            """
            INSERT INTO sync_batches(
                batch_id, worker_id, platform, account_key, token_digest,
                payload_sha256, status, counts_json, cursor_before, cursor_after,
                error_code, error_message, started_at, finished_at, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'OK', ?, ?, ?, NULL, NULL, ?, ?, ?)
            """,
            (
                payload.batch_id,
                payload.worker_id,
                payload.platform,
                payload.platform_account_key,
                token_digest,
                payload_sha256,
                batch_counts_json(created, updated, skipped, 0),
                payload.cursor_before,
                payload.cursor_after,
                db_timestamp(payload.started_at),
                db_timestamp(payload.finished_at),
                now,
            ),
        )
        if manage_transaction:
            connection.commit()
        return counts
    except BaseException as exc:
        if manage_transaction:
            try:
                connection.rollback()
            except sqlite3.Error:
                pass
        try:
            if not manage_transaction:
                # The caller owns the transaction and must roll it back as a
                # unit with any associated cursor update.  In particular, do
                # not insert an error batch here because that would make a
                # failed API sync look partially committed.
                raise
            connection.execute(
                """
                INSERT INTO sync_batches(
                    batch_id, worker_id, platform, account_key, token_digest,
                    payload_sha256, status, counts_json, cursor_before, cursor_after,
                    error_code, error_message, started_at, finished_at, received_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'ERROR', ?, ?, ?, 'INGEST_FAILED', ?, ?, ?, ?)
                """,
                (
                    payload.batch_id,
                    payload.worker_id,
                    payload.platform,
                    payload.platform_account_key,
                    token_digest,
                    payload_sha256,
                    batch_counts_json(0, 0, 0, 1),
                    payload.cursor_before,
                    payload.cursor_after,
                    str(exc)[:500],
                    db_timestamp(payload.started_at),
                    db_timestamp(payload.finished_at),
                    now,
                ),
            )
            connection.commit()
        except sqlite3.Error:
            pass
        raise


def _upsert_platform_account_in_tx(
    connection: sqlite3.Connection, payload: SyncBatchIn, now: str
) -> int:
    row = connection.execute(
        "SELECT id FROM platform_accounts WHERE platform = ? AND account_key = ?",
        (payload.platform, payload.platform_account_key),
    ).fetchone()
    if row is not None:
        if payload.source == "ALI1688_API":
            connection.execute(
                "UPDATE platform_accounts SET display_label = COALESCE(?, display_label), source = ?, updated_at = ? WHERE id = ?",
                (payload.platform_account_label, payload.source, now, row["id"]),
            )
        return row["id"]
    cursor = connection.execute(
        """
        INSERT INTO platform_accounts(platform, account_key, display_label, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (payload.platform, payload.platform_account_key, payload.platform_account_label, payload.source, now, now),
    )
    return cursor.lastrowid


def _upsert_order(
    connection: sqlite3.Connection,
    account_id: int,
    order: SyncOrderIn,
    now: str,
    created: int,
    updated: int,
    skipped: int,
    source: str = SYNC_SOURCE,
) -> tuple[int, int, int]:
    ordered_at = db_timestamp(order.ordered_at) if order.ordered_at is not None else None
    existing = connection.execute(
        """
        SELECT id, ordered_at, order_status, shop_name, source
        FROM purchase_orders
        WHERE platform_account_id = ? AND platform_order_id = ?
        """,
        (account_id, order.platform_order_id),
    ).fetchone()

    changed = False
    counted = False
    if existing is None:
        cursor = connection.execute(
            """
            INSERT INTO purchase_orders(
                platform_account_id, platform_order_id, ordered_at, order_status,
                shop_name, source, last_seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                account_id,
                order.platform_order_id,
                ordered_at,
                order.status,
                order.shop_name,
                source,
                now,
                now,
                now,
            ),
        )
        order_id = cursor.lastrowid
        created += 1
        changed = True
        counted = True
    else:
        order_id = existing["id"]
        if (
            existing["ordered_at"] != ordered_at
            or existing["order_status"] != order.status
            or existing["shop_name"] != order.shop_name
            or existing["source"] != source
        ):
            connection.execute(
                """
                UPDATE purchase_orders
                SET ordered_at = ?, order_status = ?, shop_name = ?, source = ?,
                    last_seen_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (ordered_at, order.status, order.shop_name, source, now, now, order_id),
            )
            updated += 1
            changed = True
            counted = True

    fingerprint_keys: list[str] = []
    for item in order.items:
        key = item_identity(item.item_key, item.title, item.sku_text)
        if key.startswith("fp:"):
            fingerprint_keys.append(key)
        existing_item = connection.execute(
            """
            SELECT id, title, sku_text, quantity, unit_price
            FROM order_items WHERE order_id = ? AND item_key = ?
            """,
            (order_id, key),
        ).fetchone()
        if existing_item is None:
            cursor = connection.execute(
                """
                INSERT INTO order_items(order_id, item_key, title, sku_text, quantity, unit_price)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    order_id,
                    key,
                    item.title,
                    item.sku_text,
                    str(item.quantity),
                    item.unit_price,
                ),
            )
            changed = True
        else:
            quantity_text = str(item.quantity)
            if (
                existing_item["title"] != item.title
                or existing_item["sku_text"] != item.sku_text
                or existing_item["quantity"] != quantity_text
                or existing_item["unit_price"] != item.unit_price
            ):
                connection.execute(
                    """
                    UPDATE order_items
                    SET title = ?, sku_text = ?, quantity = ?, unit_price = ?
                    WHERE id = ?
                    """,
                    (item.title, item.sku_text, quantity_text, item.unit_price, existing_item["id"]),
                )
                changed = True

    if fingerprint_keys:
        placeholders = ",".join("?" for _ in fingerprint_keys)
        connection.execute(
            f"""
            DELETE FROM order_items
            WHERE order_id = ? AND item_key LIKE 'fp:%'
              AND item_key NOT IN ({placeholders})
            """,
            (order_id, *fingerprint_keys),
        )
    else:
        connection.execute(
            "DELETE FROM order_items WHERE order_id = ? AND item_key LIKE 'fp:%'",
            (order_id,),
        )

    for package in order.packages:
        courier_normalized = normalize_courier(package.courier or "")
        tracking_normalized = normalize_tracking_no(package.tracking_no)
        package_row = connection.execute(
            """
            SELECT id, courier, courier_normalized, package_status
            FROM packages
            WHERE courier_normalized = ? AND tracking_no_normalized = ?
            """,
            (courier_normalized, tracking_normalized),
        ).fetchone()
        if package_row is None:
            candidates = connection.execute(
                """
                SELECT id, courier, courier_normalized, package_status
                FROM packages WHERE tracking_no_normalized = ?
                """,
                (tracking_normalized,),
            ).fetchall()
            if len(candidates) == 1:
                candidate = candidates[0]
                if (
                    courier_normalized == ""
                    or candidate["courier_normalized"] == ""
                    or candidate["courier_normalized"] == courier_normalized
                ):
                    package_row = candidate
        if package_row is None:
            cursor = connection.execute(
                """
                INSERT INTO packages(
                    courier, courier_normalized, tracking_no, tracking_no_normalized,
                    package_status, source, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    package.courier,
                    courier_normalized,
                    package.tracking_no,
                    tracking_normalized,
                    package.status,
                    source,
                    now,
                    now,
                ),
            )
            package_id = cursor.lastrowid
            changed = True
        else:
            package_id = package_row["id"]
            updates: list[str] = []
            parameters: list[str | None] = []
            if courier_normalized and package_row["courier_normalized"] != courier_normalized:
                updates.append("courier = ?, courier_normalized = ?")
                parameters.extend([package.courier, courier_normalized])
            elif (
                package.courier is not None
                and package_row["courier"] != package.courier
            ):
                updates.append("courier = ?")
                parameters.append(package.courier)
            if (
                package.status is not None
                and package_row["package_status"] != package.status
            ):
                updates.append("package_status = ?")
                parameters.append(package.status)
            if updates:
                parameters.extend([now, package_id])
                connection.execute(
                    f"""
                    UPDATE packages SET {", ".join(updates)}, updated_at = ? WHERE id = ?
                    """,
                    parameters,
                )
                changed = True
        link_cursor = connection.execute(
            """
            INSERT OR IGNORE INTO package_order_links(package_id, order_id, order_item_id, created_at)
            VALUES (?, ?, NULL, ?)
            """,
            (package_id, order_id, now),
        )
        if link_cursor.rowcount == 1:
            changed = True

    if changed and not counted:
        connection.execute(
            """
            UPDATE purchase_orders SET last_seen_at = ?, updated_at = ? WHERE id = ?
            """,
            (now, now, order_id),
        )
        updated += 1
    if not changed and counted is False:
        skipped += 1
    return created, updated, skipped
