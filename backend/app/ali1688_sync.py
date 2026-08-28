from __future__ import annotations

import json
import hashlib
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .ali1688_client import Ali1688Client, Ali1688ValidationError, ClientLimits
from .ali1688_config import Ali1688Account, Ali1688App, Ali1688Config
from .ali1688_mapping import list_orders, map_order
from .sync_ingest import SyncBatchIn, ingest_sync_batch


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def account_lock(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


ALI1688_TZ = timezone(timedelta(hours=8))


def _stamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def format_api_datetime(value: datetime) -> str:
    """Format a datetime as Alibaba's java.util.Date wire value."""
    return value.astimezone(ALI1688_TZ).strftime("%Y%m%d%H%M%S%f")[:17] + "+0800"


def _overlap_start(cursor: str | None, fallback: datetime) -> str:
    if not cursor:
        return format_api_datetime(fallback)
    try:
        if re.fullmatch(r"\d{17}[+-]\d{4}", cursor):
            parsed = datetime.strptime(cursor, "%Y%m%d%H%M%S%f%z")
        else:
            parsed = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return format_api_datetime(parsed - timedelta(minutes=5))
    except ValueError:
        return format_api_datetime(fallback)


def ensure_state(connection, account_key: str, now: str) -> None:
    connection.execute(
        "INSERT OR IGNORE INTO ali1688_sync_state(account_key, cursor, last_success_at, last_error_at, last_error_code, last_error_message, last_count, updated_at) VALUES (?, NULL, NULL, NULL, NULL, NULL, 0, ?)",
        (account_key, now),
    )


def _finish_run(database, run_id: str, status: str, count: int = 0, code: str | None = None) -> None:
    now = _stamp(datetime.now(timezone.utc))
    with database.connect() as connection:
        connection.execute("UPDATE ali1688_sync_runs SET status=?, finished_at=?, count=?, error_code=? WHERE run_id=?", (status, now, count, code, run_id))
        connection.commit()


def sync_account(database, app: Ali1688App, account: Ali1688Account, *, dry_run: bool = False, page_size: int = 20, max_pages: int = 25, backfill_days: int = 30, client: Ali1688Client | None = None, client_limits: ClientLimits | None = None) -> dict[str, Any]:
    if page_size < 1 or page_size > 20:
        raise ValueError("page_size must be between 1 and 20")
    if max_pages < 1 or max_pages > 100:
        raise ValueError("max_pages must be between 1 and 100")
    if backfill_days < 1 or backfill_days > 3650:
        raise ValueError("backfill_days must be between 1 and 3650")
    lock = account_lock(account.account_key)
    if not lock.acquire(blocking=False):
        return {"account_key": account.account_key, "status": "SKIPPED", "reason": "already running"}
    try:
        now = datetime.now(timezone.utc)
        run_id = str(uuid.uuid4()) if not dry_run else None
        with database.connect() as connection:
            if not dry_run:
                ensure_state(connection, account.account_key, _stamp(now))
                connection.execute("INSERT INTO ali1688_sync_runs(account_key, run_id, status, started_at) VALUES (?, ?, 'RUNNING', ?)", (account.account_key, run_id, _stamp(now)))
                connection.commit()
            row = connection.execute("SELECT cursor FROM ali1688_sync_state WHERE account_key = ?", (account.account_key,)).fetchone()
        cursor = row["cursor"] if row else None
        start = _overlap_start(cursor, now - timedelta(days=backfill_days))
        owns_client = client is None
        client = client or Ali1688Client(app, account, limits=client_limits)
        raw_orders: list[dict[str, Any]] = []
        seen_order_ids: set[str] = set()
        hit_page_cap = True
        end_api = format_api_datetime(now)
        for page in range(1, max_pages + 1):
            # The list API documents modifyStartTime/modifyEndTime for
            # incremental synchronization.  The initial window remains
            # bounded by backfill_days through the same modify-time range.
            response = client.get_buyer_order_list(
                modify_start_time=start,
                modify_end_time=end_api,
                page=page,
                page_size=page_size,
            )
            try:
                page_orders = list_orders(response)
            except ValueError as exc:
                raise Ali1688ValidationError(
                    "1688 order list contains an invalid item"
                ) from exc
            result_shape = response.get("result") if isinstance(response, dict) else None
            known_list_shape = isinstance(result_shape, list) or (
                isinstance(result_shape, dict)
                and any(isinstance(result_shape.get(key), list) for key in ("orders", "orderList", "result"))
            )
            if not known_list_shape:
                raise Ali1688ValidationError("1688 order list response shape changed")
            for order in page_orders:
                base = order.get("baseInfo") if isinstance(order.get("baseInfo"), dict) else order
                oid = base.get("idOfStr") if isinstance(base, dict) else None
                if not isinstance(oid, str) or not oid.strip():
                    raise Ali1688ValidationError("1688 order list item is missing idOfStr")
                if oid not in seen_order_ids:
                    seen_order_ids.add(oid)
                    raw_orders.append(order)
            total_record = response.get("totalRecord") if isinstance(response, dict) else None
            try:
                reached_reported_total = total_record is not None and page * page_size >= int(total_record)
            except (TypeError, ValueError):
                reached_reported_total = False
            if len(page_orders) < page_size or reached_reported_total:
                hit_page_cap = False
                break
        mapped = []
        for order in raw_orders:
            base = order.get("baseInfo") if isinstance(order.get("baseInfo"), dict) else order
            oid = base.get("idOfStr") if isinstance(base, dict) else None
            if oid is None:
                continue
            detail = client.get_buyer_view(str(oid))
            result = detail.get("result") if isinstance(detail, dict) else None
            if not isinstance(result, dict):
                raise Ali1688ValidationError("1688 order detail response shape changed")
            detail_obj = result
            try:
                mapped.append(map_order(order, detail_obj))
            except Exception as exc:
                raise Ali1688ValidationError(
                    "1688 order mapping failed closed"
                ) from exc
        count = len(mapped)
        # If the configured cap was reached on a full page, leave the cursor
        # unchanged so the next run repeats the overlapped window and cannot
        # silently skip older records beyond the cap.
        new_cursor = cursor if hit_page_cap else end_api
        if dry_run:
            return {"account_key": account.account_key, "status": "DRY_RUN", "orders": count, "cursor_before": cursor, "cursor_after": new_cursor, "page_cap_reached": hit_page_cap}
        if not mapped:
            # A valid empty page is still a successful cursor advancement.
            mapped = []
        counts = {"created": 0, "updated": 0, "skipped": 0}
        with database.connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                # The shared ingest contract deliberately caps a batch at 100
                # orders.  A normal 1688 backfill can exceed that, so ingest
                # chunks in one outer transaction and advance the cursor only
                # after every chunk succeeds.
                for offset in range(0, len(mapped), 100):
                    chunk = mapped[offset:offset + 100]
                    batch = SyncBatchIn(schema_version=1, batch_id=str(uuid.uuid4()), worker_id="ali1688-api", platform="1688", platform_account_key=account.account_key, platform_account_label=account.display_label, source="ALI1688_API", started_at=now, finished_at=datetime.now(timezone.utc), cursor_before=cursor, cursor_after=new_cursor, mode="commit", orders=chunk)
                    payload_bytes = json.dumps(batch.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
                    chunk_counts = ingest_sync_batch(connection, batch, hashlib.sha256(payload_bytes).hexdigest(), "ali1688-api", _stamp(datetime.now(timezone.utc)), manage_transaction=False)
                    for key in counts:
                        counts[key] += chunk_counts[key]
                connection.execute("UPDATE ali1688_sync_state SET cursor=?, last_success_at=?, last_error_at=NULL, last_error_code=NULL, last_error_message=NULL, last_count=?, updated_at=? WHERE account_key=?", (new_cursor, _stamp(datetime.now(timezone.utc)), count, _stamp(datetime.now(timezone.utc)), account.account_key))
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        run_status = "PARTIAL" if hit_page_cap else "OK"
        _finish_run(database, run_id, run_status, count)
        return {"account_key": account.account_key, "status": run_status, "orders": count, **counts, "cursor_after": new_cursor, "page_cap_reached": hit_page_cap}
    except Exception as exc:
        with database.connect() as connection:
            if dry_run:
                return {"account_key": account.account_key, "status": "ERROR", "error_code": getattr(exc, "code", "SYNC_FAILED"), "error": "1688 sync failed"}
            now_text = _stamp(datetime.now(timezone.utc))
            connection.execute("UPDATE ali1688_sync_state SET last_error_at=?, last_error_code=?, last_error_message=?, updated_at=? WHERE account_key=?", (now_text, getattr(exc, "code", "SYNC_FAILED"), "1688 sync failed", now_text, account.account_key))
            connection.commit()
        _finish_run(database, run_id, "ERROR", 0, getattr(exc, "code", "SYNC_FAILED"))
        return {"account_key": account.account_key, "status": "ERROR", "error_code": getattr(exc, "code", "SYNC_FAILED"), "error": "1688 sync failed"}
    finally:
        if "owns_client" in locals() and owns_client and client is not None:
            client.close()
        lock.release()


def sync_config(database, config: Ali1688Config, *, account_key: str | None = None, dry_run: bool = False, **kwargs: Any) -> list[dict[str, Any]]:
    targets = [(app, account) for app, account in config.accounts() if account_key is None or account.account_key == account_key]
    if account_key is not None and not targets:
        raise ValueError("unknown 1688 account key")
    results = []
    for app, account in targets:
        results.append(sync_account(database, app, account, dry_run=dry_run, **kwargs))
    return results
