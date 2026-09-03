from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import sqlite3
import tempfile
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from pydantic import ValidationError

from .config import Settings
from .ali1688_config import Ali1688Config, Ali1688ConfigError, load_config
from .ali1688_client import ClientLimits
from .ali1688_sync import ensure_state, sync_config
from .database import Database
from .manual_order_batch import (
    expand_manual_batch_inputs,
    manual_batch_event_id,
    manual_batch_payload_digest,
    read_manual_batch_payload,
    manual_tracking_format_error,
    validate_manual_batch_input,
    ManualBatchValidationFailure,
)
from .schemas import (
    AuthResponse,
    DashboardStatsOut,
    LoginRequest,
    ManualOrderBatchCreate,
    ManualOrderBatchCreateResponse,
    ManualOrderBatchItemResult,
    ManualOrderCreate,
    ManualOrderCreateResponse,
    OrderArrivalAuditEventOut,
    OrderArrivalAuditListResponse,
    OrderArrivalStateOut,
    OrderArrivalStatusUpdate,
    PasswordChangeRequest,
    PlatformAccountCreate,
    PlatformAccountListResponse,
    PlatformAccountOut,
    PlatformAccountStatusIn,
    PurchaseOrderListResponse,
    PurchaseOrderOut,
    ReceiptCreateResponse,
    ReceiptListResponse,
    ReceiptOut,
    TrackingUpdate,
    UserActivationUpdate,
    UserCreate,
    UserListResponse,
    UserManagementAuditEventOut,
    UserManagementAuditListResponse,
    UserOut,
)
from .security import (
    hash_password,
    new_session_token,
    session_token_digest,
    verify_password,
)
from .sync_ingest import (
    SyncBatchIn,
    SyncBatchResponse,
    canonical_payload_digest,
    ingest_sync_batch,
    parse_batch_counts,
    normalize_courier,
)
from .zhipu_vl import extract_tracking_candidates, resolve_tracking_candidate


logger = logging.getLogger(__name__)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def db_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def parse_client_timestamp(raw: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="captured_at must be an ISO 8601 timestamp",
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="captured_at must include a timezone offset",
        )
    return parsed.astimezone(timezone.utc)


def normalize_tracking_no(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def recompute_tracking_duplicates(
    connection: sqlite3.Connection, tracking_no_normalized: str | None
) -> None:
    if not tracking_no_normalized:
        return
    matching_rows = connection.execute(
        """
        SELECT id FROM receipt_events
        WHERE tracking_no_normalized = ? AND evidence_status = 'READY'
        ORDER BY server_received_at ASC, id ASC
        """,
        (tracking_no_normalized,),
    ).fetchall()
    if not matching_rows:
        return
    first_id = matching_rows[0]["id"]
    connection.execute(
        """
        UPDATE receipt_events
        SET duplicate_of_receipt_id = CASE WHEN id = ? THEN NULL ELSE ? END
        WHERE tracking_no_normalized = ? AND evidence_status = 'READY'
        """,
        (first_id, first_id, tracking_no_normalized),
    )


@dataclass
class AuthenticatedUser:
    id: int
    username: str
    display_name: str
    role: str
    session_id: str
    last_login_at: datetime | None = None

    def public(self) -> UserOut:
        return UserOut(
            id=self.id,
            username=self.username,
            display_name=self.display_name,
            role=self.role,
            is_active=True,
            last_login_at=self.last_login_at,
        )


@dataclass(frozen=True)
class AuthenticatedSyncWorker:
    token_digest: str


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _database(request: Request) -> Database:
    return request.app.state.database


def require_sync_worker(request: Request) -> AuthenticatedSyncWorker:
    settings = _settings(request)
    if not settings.sync_worker_tokens:
        raise HTTPException(
            status_code=503,
            detail="sync ingest is not configured on this server",
        )

    authorization = request.headers.get("authorization", "").strip()
    match = re.fullmatch(r"[Bb]earer\s+(\S+)", authorization)
    if match is None:
        raise HTTPException(status_code=401, detail="invalid worker token")
    token_digest = session_token_digest(settings.session_secret, match.group(1))
    with _database(request).connect() as connection:
        token_row = connection.execute(
            "SELECT id, revoked_at FROM sync_worker_tokens WHERE token_digest = ?",
            (token_digest,),
        ).fetchone()
    if token_row is None:
        raise HTTPException(status_code=401, detail="invalid worker token")
    if token_row["revoked_at"] is not None:
        raise HTTPException(status_code=403, detail="worker token revoked")
    return AuthenticatedSyncWorker(token_digest=token_digest)


def require_user(request: Request) -> AuthenticatedUser:
    settings = _settings(request)
    database = _database(request)

    if not settings.auth_required:
        request_host = (request.url.hostname or "").lower()
        if request_host not in settings.trusted_hosts:
            raise HTTPException(status_code=403, detail="trusted LAN access required")
        client_ip_raw = (
            request.headers.get("x-real-ip")
            or (request.client.host if request.client else "")
        ).strip()
        try:
            client_ip = ipaddress.ip_address(client_ip_raw)
        except ValueError as exc:
            raise HTTPException(
                status_code=403,
                detail="trusted LAN access required",
            ) from exc
        if not any(
            client_ip in ipaddress.ip_network(cidr, strict=False)
            for cidr in settings.trusted_lan_cidrs
        ):
            raise HTTPException(status_code=403, detail="trusted LAN access required")
        if (
            request.method not in {"GET", "HEAD", "OPTIONS"}
            and request.headers.get("x-arrival-client") != "wechat-h5"
        ):
            raise HTTPException(status_code=403, detail="trusted client header required")
        with database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, username, display_name, role, is_active, last_login_at
                FROM users WHERE username = ?
                """,
                (settings.trusted_user_username.strip(),),
            ).fetchone()
        if row is None or not row["is_active"]:
            raise HTTPException(
                status_code=503,
                detail="trusted LAN operator is unavailable",
            )
        return AuthenticatedUser(
            id=row["id"],
            username=row["username"],
            display_name=row["display_name"],
            role=row["role"],
            session_id="trusted-lan",
            last_login_at=row["last_login_at"],
        )

    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise HTTPException(status_code=401, detail="authentication required")

    digest = session_token_digest(settings.session_secret, token)
    with database.connect() as connection:
        row = connection.execute(
            """
            SELECT
                s.id AS session_id, s.expires_at,
                u.id, u.username, u.display_name, u.role, u.is_active,
                u.last_login_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_digest = ? AND s.revoked_at IS NULL
            """,
            (digest,),
        ).fetchone()
        if row is None or not row["is_active"]:
            raise HTTPException(status_code=401, detail="invalid session")
        expires_at = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
        if expires_at <= utc_now():
            connection.execute(
                "UPDATE sessions SET revoked_at = ? WHERE id = ?",
                (db_timestamp(utc_now()), row["session_id"]),
            )
            connection.commit()
            raise HTTPException(status_code=401, detail="session expired")

    return AuthenticatedUser(
        id=row["id"],
        username=row["username"],
        display_name=row["display_name"],
        role=row["role"],
        session_id=row["session_id"],
        last_login_at=row["last_login_at"],
    )


def require_admin(
    user: Annotated[AuthenticatedUser, Depends(require_user)],
) -> AuthenticatedUser:
    if user.role != "ADMIN":
        raise HTTPException(status_code=403, detail="administrator access required")
    return user


PLATFORM_ACCOUNT_SELECT = """
SELECT
    accounts.id,
    accounts.platform,
    accounts.account_key,
    accounts.display_label,
    accounts.source,
    COALESCE(sync_state.status, 'NEEDS_LOGIN') AS status,
    sync_state.worker_id,
    (
        SELECT COUNT(*)
        FROM purchase_orders
        WHERE purchase_orders.platform_account_id = accounts.id
    ) AS order_count,
    sync_state.last_attempt_at,
    sync_state.last_success_at,
    COALESCE(sync_state.last_count, 0) AS last_count,
    sync_state.message,
    accounts.created_at,
    accounts.updated_at,
    COALESCE(sync_state.updated_at, accounts.updated_at) AS status_updated_at
FROM platform_accounts AS accounts
LEFT JOIN platform_account_sync_state AS sync_state
  ON sync_state.platform_account_id = accounts.id
"""


def _platform_account_from_row(row: sqlite3.Row) -> PlatformAccountOut:
    return PlatformAccountOut(**dict(row))


RECEIPT_SELECT = """
SELECT
    r.*,
    u.username AS operator_username,
    u.display_name AS operator_display_name,
    u.role AS operator_role,
    u.is_active AS operator_is_active,
    modifier.id AS modifier_user_id,
    modifier.username AS modifier_username,
    modifier.display_name AS modifier_display_name,
    modifier.role AS modifier_role,
    modifier.is_active AS modifier_is_active,
    latest_change.created_at AS last_modified_at,
    duplicate.server_received_at AS duplicate_server_received_at
FROM receipt_events r
JOIN users u ON u.id = r.operator_user_id
LEFT JOIN receipt_events duplicate ON duplicate.id = r.duplicate_of_receipt_id
LEFT JOIN receipt_change_events AS latest_change
  ON latest_change.id = (
      SELECT changes.id
      FROM receipt_change_events AS changes
      WHERE changes.receipt_id = r.id
      ORDER BY changes.id DESC
      LIMIT 1
  )
LEFT JOIN users AS modifier ON modifier.id = latest_change.actor_user_id
"""


def _order_matches(
    connection: sqlite3.Connection, tracking_no_normalized: str | None
) -> list[dict]:
    if not tracking_no_normalized:
        return []
    rows = connection.execute(
        """
        SELECT
            o.id AS order_id,
            pa.platform AS platform,
            pa.display_label AS account_label,
            o.platform_order_id AS platform_order_id,
            o.shop_name AS shop_name,
            p.courier AS courier,
            p.tracking_no AS tracking_no,
            oi.id AS item_id,
            oi.title AS item_title,
            oi.sku_text AS item_sku,
            oi.quantity AS item_quantity
        FROM packages p
        JOIN package_order_links l ON l.package_id = p.id
        JOIN purchase_orders o ON o.id = l.order_id
        JOIN platform_accounts pa ON pa.id = o.platform_account_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE p.tracking_no_normalized = ?
        ORDER BY o.id, oi.id
        """,
        (tracking_no_normalized,),
    ).fetchall()
    grouped: dict[int, dict] = {}
    item_ids: dict[int, set[int]] = {}
    for row in rows:
        key = row["order_id"]
        match = grouped.get(key)
        if match is None:
            match = {
                "order_id": str(row["order_id"]),
                "platform": row["platform"],
                "platform_order_id": row["platform_order_id"],
                "account_label": row["account_label"],
                "shop_name": row["shop_name"],
                "courier": row["courier"],
                "tracking_no": row["tracking_no"],
                "items": [],
            }
            grouped[key] = match
            item_ids[key] = set()
        if row["item_title"] is not None and row["item_id"] not in item_ids[key]:
            match["items"].append(
                {
                    "title": row["item_title"],
                    "sku_text": row["item_sku"],
                    "quantity": row["item_quantity"],
                }
            )
            item_ids[key].add(row["item_id"])
    matches = list(grouped.values())
    confidence: Literal["EXACT", "CANDIDATE"] = "EXACT" if len(matches) <= 1 else "CANDIDATE"
    for match in matches:
        match["confidence"] = confidence
    return matches


def _receipt_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> ReceiptOut:
    photo_url = f"/api/receipts/{row['id']}/photo"
    duplicate_id = row["duplicate_of_receipt_id"]
    duplicate = None
    if duplicate_id is not None:
        duplicate = {
            "id": duplicate_id,
            "server_received_at": row["duplicate_server_received_at"],
            "photo_url": f"/api/receipts/{duplicate_id}/photo",
        }
    return ReceiptOut(
        id=row["id"],
        client_event_id=row["client_event_id"],
        captured_at=row["captured_at"],
        occurred_at=row["captured_at"],
        server_received_at=row["server_received_at"],
        device_id=row["device_id"],
        barcode_candidate=row["barcode_candidate"],
        tracking_no=row["tracking_no"],
        evidence_status=row["evidence_status"],
        photo_url=photo_url,
        is_duplicate=duplicate_id is not None,
        duplicate_of_id=duplicate_id,
        duplicate_of=duplicate,
        operator=UserOut(
            id=row["operator_user_id"],
            username=row["operator_username"],
            display_name=row["operator_display_name"],
            role=row["operator_role"],
            is_active=bool(row["operator_is_active"]),
        ),
        last_modified_by=(
            UserOut(
                id=row["modifier_user_id"],
                username=row["modifier_username"],
                display_name=row["modifier_display_name"],
                role=row["modifier_role"],
                is_active=bool(row["modifier_is_active"]),
            )
            if row["modifier_user_id"] is not None
            else None
        ),
        last_modified_at=row["last_modified_at"],
        photo={
            "content_type": row["photo_content_type"],
            "size": row["photo_size"],
            "sha256": row["photo_sha256"],
            "url": photo_url,
        },
        order_matches=_order_matches(connection, row["tracking_no_normalized"]),
    )


def _fetch_receipt(
    connection: sqlite3.Connection,
    *,
    receipt_id: int | None = None,
    client_event_id: str | None = None,
) -> sqlite3.Row | None:
    if receipt_id is not None:
        return connection.execute(
            RECEIPT_SELECT + " WHERE r.id = ?", (receipt_id,)
        ).fetchone()
    return connection.execute(
        RECEIPT_SELECT + " WHERE r.client_event_id = ?", (client_event_id,)
    ).fetchone()


ORDER_ARRIVAL_STATE_SELECT = """
WITH canonical_receipts AS (
    SELECT
        receipts.id,
        receipts.tracking_no_normalized,
        receipts.operator_user_id AS responsible_user_id,
        receipts.server_received_at AS responsibility_at
    FROM receipt_events AS receipts
    WHERE receipts.evidence_status = 'READY'
      AND receipts.duplicate_of_receipt_id IS NULL
),
tracking_order_counts AS (
    SELECT
        packages.tracking_no_normalized,
        COUNT(DISTINCT links.order_id) AS order_count
    FROM packages
    JOIN package_order_links AS links ON links.package_id = packages.id
    GROUP BY packages.tracking_no_normalized
),
order_tracking AS (
    SELECT DISTINCT links.order_id, packages.tracking_no_normalized
    FROM package_order_links AS links
    JOIN packages ON packages.id = links.package_id
    WHERE links.order_id = ?
),
arrival_metrics AS (
    SELECT
        order_tracking.order_id,
        COUNT(DISTINCT order_tracking.tracking_no_normalized) AS package_count,
        COUNT(DISTINCT CASE
            WHEN receipts.id IS NOT NULL AND counts.order_count = 1
            THEN order_tracking.tracking_no_normalized END
        ) AS arrived_package_count,
        COUNT(DISTINCT CASE
            WHEN receipts.id IS NOT NULL AND counts.order_count > 1
            THEN order_tracking.tracking_no_normalized END
        ) AS candidate_package_count
    FROM order_tracking
    LEFT JOIN tracking_order_counts AS counts
      ON counts.tracking_no_normalized = order_tracking.tracking_no_normalized
    LEFT JOIN canonical_receipts AS receipts
      ON receipts.tracking_no_normalized = order_tracking.tracking_no_normalized
    GROUP BY order_tracking.order_id
),
latest_receipt AS (
    SELECT receipts.responsible_user_id, receipts.responsibility_at
    FROM canonical_receipts AS receipts
    JOIN packages
      ON packages.tracking_no_normalized = receipts.tracking_no_normalized
    JOIN package_order_links AS links ON links.package_id = packages.id
    WHERE links.order_id = ?
    ORDER BY receipts.responsibility_at DESC, receipts.id DESC
    LIMIT 1
),
evidence AS (
    SELECT
        orders.id AS order_id,
        orders.order_status AS order_status,
        orders.updated_at AS order_updated_at,
        CASE
            WHEN COALESCE(metrics.package_count, 0) > 0
             AND COALESCE(metrics.arrived_package_count, 0) >=
                 COALESCE(metrics.package_count, 0)
            THEN 'RECEIVED'
            WHEN (
                COALESCE(metrics.arrived_package_count, 0) > 0
                AND COALESCE(metrics.arrived_package_count, 0) <
                    COALESCE(metrics.package_count, 0)
            ) OR COALESCE(metrics.candidate_package_count, 0) > 0
            THEN 'REVIEW'
            ELSE 'PENDING'
        END AS evidence_arrival_status
    FROM purchase_orders AS orders
    LEFT JOIN arrival_metrics AS metrics ON metrics.order_id = orders.id
    WHERE orders.id = ?
)
SELECT
    evidence.order_id,
    evidence.evidence_arrival_status,
    CASE
        WHEN UPPER(TRIM(evidence.order_status)) IN ('CANCELLED', 'REFUNDED')
        THEN 'CLOSED'
        ELSE COALESCE(overrides.status, evidence.evidence_arrival_status)
    END AS effective_arrival_status,
    CASE
        WHEN UPPER(TRIM(evidence.order_status)) IN ('CANCELLED', 'REFUNDED')
        THEN 'AUTO'
        WHEN overrides.order_id IS NULL THEN 'AUTO'
        ELSE 'MANUAL'
    END AS arrival_source,
    COALESCE(overrides.revision, 0) AS manual_revision,
    CASE
        WHEN UPPER(TRIM(evidence.order_status)) IN ('CANCELLED', 'REFUNDED')
        THEN evidence.order_updated_at
        WHEN overrides.order_id IS NULL THEN latest_receipt.responsibility_at
        ELSE overrides.changed_at
    END AS changed_at,
    responsible.id AS responsible_user_id,
    responsible.username AS responsible_username,
    responsible.display_name AS responsible_display_name,
    responsible.role AS responsible_role,
    responsible.is_active AS responsible_is_active
FROM evidence
LEFT JOIN order_arrival_overrides AS overrides
  ON overrides.order_id = evidence.order_id
LEFT JOIN latest_receipt ON 1 = 1
LEFT JOIN users AS responsible
  ON responsible.id = CASE
      WHEN UPPER(TRIM(evidence.order_status)) IN ('CANCELLED', 'REFUNDED') THEN NULL
      WHEN overrides.order_id IS NULL THEN latest_receipt.responsible_user_id
      ELSE overrides.actor_user_id
  END
"""


def _fetch_order_arrival_state(
    connection: sqlite3.Connection,
    order_id: int,
    *,
    audit_event_id: int | None = None,
    idempotent_replay: bool = False,
) -> OrderArrivalStateOut | None:
    row = connection.execute(
        ORDER_ARRIVAL_STATE_SELECT,
        (order_id, order_id, order_id),
    ).fetchone()
    if row is None:
        return None
    responsible = None
    if row["responsible_user_id"] is not None:
        responsible = UserOut(
            id=row["responsible_user_id"],
            username=row["responsible_username"],
            display_name=row["responsible_display_name"],
            role=row["responsible_role"],
            is_active=bool(row["responsible_is_active"]),
        )
    return OrderArrivalStateOut(
        order_id=str(row["order_id"]),
        effective_arrival_status=row["effective_arrival_status"],
        evidence_arrival_status=row["evidence_arrival_status"],
        arrival_source=row["arrival_source"],
        responsible_user=responsible,
        manual_revision=row["manual_revision"],
        changed_at=row["changed_at"],
        audit_event_id=audit_event_id,
        idempotent_replay=idempotent_replay,
    )


def _arrival_audit_from_row(row: sqlite3.Row) -> OrderArrivalAuditEventOut:
    return OrderArrivalAuditEventOut(
        id=row["id"],
        client_event_id=row["client_event_id"],
        order_id=str(row["order_id"]),
        actor=UserOut(
            id=row["actor_user_id"],
            username=row["actor_username"],
            display_name=row["actor_display_name"],
            role=row["actor_role"],
            is_active=bool(row["actor_is_active"]),
        ),
        action=row["action"],
        previous_effective_status=row["previous_effective_status"],
        new_effective_status=row["new_effective_status"],
        previous_override_status=row["previous_override_status"],
        new_override_status=row["new_override_status"],
        previous_revision=row["previous_revision"],
        new_revision=row["new_revision"],
        reason=row["reason"],
        created_at=row["created_at"],
    )


def _validate_strong_password(password: str) -> None:
    categories = (
        any(character.islower() for character in password),
        any(character.isupper() for character in password),
        any(character.isdigit() for character in password),
        any(not character.isalnum() for character in password),
    )
    if len(password) < 12 or sum(categories) < 3:
        raise HTTPException(
            status_code=422,
            detail="password must be at least 12 characters and use three character classes",
        )


IMAGE_TYPES: dict[str, tuple[str, str]] = {
    "jpeg": ("image/jpeg", ".jpg"),
    "png": ("image/png", ".png"),
    "webp": ("image/webp", ".webp"),
    "heic": ("image/heic", ".heic"),
}

DECLARED_IMAGE_TYPES = {
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic",
    "application/octet-stream": None,
    "": None,
}


def detect_image_type(header: bytes) -> str | None:
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp"
    if len(header) >= 12 and header[4:8] == b"ftyp":
        brand = header[8:12]
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "heic"
    return None


async def write_validated_upload(
    upload: UploadFile, settings: Settings
) -> tuple[Path, str, str, int, str]:
    declared = (upload.content_type or "").lower().split(";", 1)[0].strip()
    if declared not in DECLARED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="unsupported image content type")

    temporary_dir = settings.media_dir / ".tmp"
    temporary_dir.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix="upload-", suffix=".tmp", dir=temporary_dir)
    temporary_path = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    header = bytearray()

    try:
        with os.fdopen(fd, "wb") as output:
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    raise HTTPException(status_code=413, detail="image exceeds upload limit")
                if len(header) < 32:
                    header.extend(chunk[: 32 - len(header)])
                digest.update(chunk)
                output.write(chunk)
            if total == 0:
                raise HTTPException(status_code=400, detail="image is empty")
            output.flush()
            os.fsync(output.fileno())

        detected = detect_image_type(bytes(header))
        if detected is None:
            raise HTTPException(status_code=415, detail="file is not a supported image")
        expected = DECLARED_IMAGE_TYPES[declared]
        if expected is not None and expected != detected:
            raise HTTPException(
                status_code=415,
                detail="declared image type does not match file content",
            )
        os.chmod(temporary_path, 0o640)
        content_type, extension = IMAGE_TYPES[detected]
        return temporary_path, content_type, extension, total, digest.hexdigest()
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


def _validate_form_text(name: str, value: str, *, minimum: int, maximum: int) -> str:
    normalized = value.strip()
    if len(normalized) < minimum or len(normalized) > maximum:
        raise HTTPException(
            status_code=422,
            detail=f"{name} must contain between {minimum} and {maximum} characters",
        )
    return normalized


def create_app(settings_override: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        settings = settings_override or Settings.from_env()
        settings.validate()
        ali_config = (
            load_config(settings.ali1688_config_path)
            if settings.ali1688_api_enabled
            else Ali1688Config()
        )
        if settings.ali1688_api_enabled and not ali_config.enabled:
            raise Ali1688ConfigError(
                "ALI1688_API_ENABLED is true but the secret config has no authorized accounts"
            )
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        (settings.media_dir / ".tmp").mkdir(parents=True, exist_ok=True)
        database = Database(settings.database_path)
        database.initialize(
            bootstrap_username=settings.bootstrap_admin_username,
            bootstrap_password=settings.bootstrap_admin_password,
            bootstrap_display_name=settings.bootstrap_admin_display_name,
            session_secret=settings.session_secret,
            sync_worker_tokens=settings.sync_worker_tokens,
            now=db_timestamp(utc_now()),
        )
        if ali_config.enabled:
            with database.connect() as connection:
                for _app, _account in ali_config.accounts():
                    ensure_state(connection, _account.account_key, db_timestamp(utc_now()))
                connection.commit()
        application.state.settings = settings
        application.state.database = database
        application.state.ali1688_config = ali_config
        scheduler_task = None
        if settings.ali1688_api_enabled and settings.ali1688_sync_interval_seconds > 0 and ali_config.enabled:
            async def run_scheduler() -> None:
                while True:
                    await asyncio.sleep(settings.ali1688_sync_interval_seconds)
                    sync_task = asyncio.create_task(
                        asyncio.to_thread(
                            sync_config,
                            database,
                            ali_config,
                            max_pages=settings.ali1688_max_pages,
                            backfill_days=settings.ali1688_backfill_days,
                            client_limits=ClientLimits(
                                timeout_seconds=settings.ali1688_timeout_seconds,
                                retries=settings.ali1688_retries,
                            ),
                        )
                    )
                    try:
                        await asyncio.shield(sync_task)
                    except asyncio.CancelledError:
                        # to_thread cannot be force-cancelled safely. Let the
                        # current transaction finish or roll back before the
                        # application shutdown completes.
                        try:
                            await sync_task
                        except Exception:
                            logger.exception(
                                "1688 scheduler iteration failed during shutdown"
                            )
                        raise
                    except Exception:
                        # An unexpected iteration failure must not permanently
                        # disable future intervals. API/client error messages are
                        # generic and never contain tokens or response bodies.
                        logger.exception("1688 scheduler iteration failed")
            scheduler_task = asyncio.create_task(run_scheduler())
        try:
            yield
        finally:
            if scheduler_task is not None:
                scheduler_task.cancel()
                try:
                    await scheduler_task
                except asyncio.CancelledError:
                    pass

    application = FastAPI(
        title="到货管家 API",
        version="0.1.0",
        lifespan=lifespan,
    )

    @application.get("/api/health")
    def health(request: Request) -> dict[str, str]:
        database = _database(request)
        with database.connect() as connection:
            connection.execute("SELECT 1").fetchone()
        if not os.access(_settings(request).media_dir, os.W_OK):
            raise HTTPException(status_code=503, detail="media directory is not writable")
        return {"status": "ok", "database": "ok", "media": "ok"}

    @application.get("/api/sync/v1/status")
    def official_sync_status(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> dict[str, Any]:
        del user
        with _database(request).connect() as connection:
            rows = connection.execute("SELECT account_key, cursor, last_success_at, last_error_at, last_error_code, last_error_message, last_count, updated_at FROM ali1688_sync_state ORDER BY account_key").fetchall()
        # This is intentionally a public projection; no token/app identifiers are returned.
        return {"enabled": bool(getattr(request.app.state, "ali1688_config", None) and request.app.state.ali1688_config.enabled), "accounts": [dict(row) for row in rows]}

    @application.post(
        "/api/sync/v1/account-status",
        response_model=PlatformAccountOut,
    )
    def report_platform_account_status(
        payload: PlatformAccountStatusIn,
        request: Request,
        worker: Annotated[
            AuthenticatedSyncWorker, Depends(require_sync_worker)
        ],
    ) -> PlatformAccountOut:
        received_at = utc_now()
        if payload.checked_at.astimezone(timezone.utc) > received_at + timedelta(
            minutes=5
        ):
            raise HTTPException(
                status_code=422,
                detail="checked_at must not be more than five minutes in the future",
            )
        now = db_timestamp(received_at)
        checked_at = db_timestamp(payload.checked_at)
        incoming_attempt = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
        with _database(request).connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                account = connection.execute(
                    """
                    SELECT id, display_label FROM platform_accounts
                    WHERE platform = 'pdd' AND account_key = ?
                    """,
                    (payload.platform_account_key,),
                ).fetchone()
                account_was_created = account is None
                if account is None:
                    connection.execute(
                        """
                        INSERT INTO platform_accounts(
                            platform, account_key, display_label, source,
                            created_at, updated_at
                        ) VALUES ('pdd', ?, ?, 'WINDOWS_BROWSER', ?, ?)
                        """,
                        (
                            payload.platform_account_key,
                            payload.platform_account_label,
                            now,
                            now,
                        ),
                    )
                    account = connection.execute(
                        """
                        SELECT id, display_label FROM platform_accounts
                        WHERE platform = 'pdd' AND account_key = ?
                        """,
                        (payload.platform_account_key,),
                    ).fetchone()
                if account is None:  # pragma: no cover - guarded by the insert
                    raise RuntimeError("platform account insert did not return an account")
                previous_state = connection.execute(
                    """
                    SELECT status, worker_id, last_attempt_at, last_success_at,
                           last_count, message
                    FROM platform_account_sync_state
                    WHERE platform_account_id = ?
                    """,
                    (account["id"],),
                ).fetchone()
                equal_replay = False
                if previous_state is not None and previous_state["last_attempt_at"]:
                    previous_attempt = datetime.fromisoformat(
                        previous_state["last_attempt_at"].replace("Z", "+00:00")
                    )
                    if incoming_attempt < previous_attempt:
                        raise HTTPException(
                            status_code=409,
                            detail="stale account status report",
                        )
                    if incoming_attempt == previous_attempt:
                        effective_label = (
                            payload.platform_account_label
                            if payload.platform_account_label is not None
                            else account["display_label"]
                        )
                        effective_count = (
                            payload.count
                            if payload.count is not None
                            else previous_state["last_count"]
                        )
                        equal_replay = all(
                            (
                                payload.status == previous_state["status"],
                                payload.worker_id == previous_state["worker_id"],
                                payload.message == previous_state["message"],
                                effective_count == previous_state["last_count"],
                                effective_label == account["display_label"],
                            )
                        )
                        if not equal_replay:
                            raise HTTPException(
                                status_code=409,
                                detail="conflicting account status report for checked_at",
                            )
                if not equal_replay:
                    if not account_was_created:
                        connection.execute(
                            """
                            UPDATE platform_accounts
                            SET display_label = COALESCE(?, display_label),
                                source = 'WINDOWS_BROWSER', updated_at = ?
                            WHERE id = ?
                            """,
                            (
                                payload.platform_account_label,
                                now,
                                account["id"],
                            ),
                        )
                    last_success_at = (
                        checked_at
                        if payload.status == "OK"
                        else (
                            previous_state["last_success_at"]
                            if previous_state is not None
                            else None
                        )
                    )
                    last_count = (
                        payload.count
                        if payload.count is not None
                        else (
                            previous_state["last_count"]
                            if previous_state is not None
                            else 0
                        )
                    )
                    connection.execute(
                        """
                        INSERT INTO platform_account_sync_state(
                            platform_account_id, status, worker_id,
                            last_attempt_at, last_success_at, last_count,
                            message, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(platform_account_id) DO UPDATE SET
                            status = excluded.status,
                            worker_id = excluded.worker_id,
                            last_attempt_at = excluded.last_attempt_at,
                            last_success_at = excluded.last_success_at,
                            last_count = excluded.last_count,
                            message = excluded.message,
                            updated_at = excluded.updated_at
                        """,
                        (
                            account["id"],
                            payload.status,
                            payload.worker_id,
                            checked_at,
                            last_success_at,
                            last_count,
                            payload.message,
                            now,
                        ),
                    )
                row = connection.execute(
                    PLATFORM_ACCOUNT_SELECT
                    + " WHERE accounts.id = ? AND accounts.platform = 'pdd'",
                    (account["id"],),
                ).fetchone()
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        if row is None:  # pragma: no cover - guarded by the transaction
            raise RuntimeError("platform account status could not be read")
        # The authenticated token digest and browser profile never enter this projection.
        del worker
        return _platform_account_from_row(row)

    @application.get(
        "/api/platform-accounts",
        response_model=PlatformAccountListResponse,
    )
    def list_platform_accounts(
        request: Request,
        admin: Annotated[AuthenticatedUser, Depends(require_admin)],
        platform: Annotated[Literal["pdd"], Query()] = "pdd",
    ) -> PlatformAccountListResponse:
        del admin
        with _database(request).connect() as connection:
            rows = connection.execute(
                PLATFORM_ACCOUNT_SELECT
                + " WHERE accounts.platform = ? ORDER BY accounts.id",
                (platform,),
            ).fetchall()
        return PlatformAccountListResponse(
            items=[_platform_account_from_row(row) for row in rows],
            total=len(rows),
        )

    @application.post(
        "/api/platform-accounts",
        response_model=PlatformAccountOut,
    )
    def register_platform_account(
        payload: PlatformAccountCreate,
        request: Request,
        admin: Annotated[AuthenticatedUser, Depends(require_admin)],
    ) -> PlatformAccountOut:
        del admin
        now = db_timestamp(utc_now())
        with _database(request).connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """
                    INSERT INTO platform_accounts(
                        platform, account_key, display_label, source,
                        created_at, updated_at
                    ) VALUES ('pdd', ?, ?, 'WINDOWS_BROWSER', ?, ?)
                    ON CONFLICT(platform, account_key) DO UPDATE SET
                        display_label = excluded.display_label,
                        source = excluded.source,
                        updated_at = excluded.updated_at
                    """,
                    (payload.account_key, payload.display_label, now, now),
                )
                account = connection.execute(
                    """
                    SELECT id FROM platform_accounts
                    WHERE platform = 'pdd' AND account_key = ?
                    """,
                    (payload.account_key,),
                ).fetchone()
                if account is None:  # pragma: no cover - guarded by the upsert
                    raise RuntimeError("platform account upsert did not return an account")
                connection.execute(
                    """
                    INSERT OR IGNORE INTO platform_account_sync_state(
                        platform_account_id, status, worker_id,
                        last_attempt_at, last_success_at, last_count,
                        message, updated_at
                    ) VALUES (?, 'NEEDS_LOGIN', NULL, NULL, NULL, 0,
                              '等待同步器首次上报状态', ?)
                    """,
                    (account["id"], now),
                )
                row = connection.execute(
                    PLATFORM_ACCOUNT_SELECT
                    + " WHERE accounts.id = ? AND accounts.platform = 'pdd'",
                    (account["id"],),
                ).fetchone()
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
        if row is None:  # pragma: no cover - guarded by the transaction
            raise RuntimeError("platform account could not be read")
        return _platform_account_from_row(row)

    def persist_manual_order(
        payload: ManualOrderCreate,
        connection: sqlite3.Connection,
        user: AuthenticatedUser,
        now: str,
    ) -> ManualOrderCreateResponse:
        """Persist one manual order inside a caller-owned write transaction."""
        tracking_no = payload.tracking_no.strip()[:128]
        tracking_format_error = manual_tracking_format_error(tracking_no)
        if tracking_format_error is not None:
            raise HTTPException(
                status_code=422,
                detail=tracking_format_error,
            )
        tracking_normalized = normalize_tracking_no(tracking_no)
        if (
            not 8 <= len(tracking_normalized) <= 32
            or not any(character.isdigit() for character in tracking_normalized)
        ):
            raise HTTPException(
                status_code=422,
                detail="规范化运单号必须为 8–32 位英文字母/数字，且至少包含一个数字",
            )
        courier = payload.courier.strip()[:128] if payload.courier else None
        courier_normalized = normalize_courier(courier or "")
        product_name = payload.product_name.strip()[:256]
        remark = payload.remark.strip()[:512] if payload.remark else None
        order_key = "manual-" + hashlib.sha256(tracking_normalized.encode("utf-8")).hexdigest()[:40]
        replay = connection.execute(
            """
            SELECT o.id, o.platform_order_id, oi.title, p.tracking_no, p.courier,
                   d.remark
            FROM manual_order_events e
            JOIN purchase_orders o ON o.id = e.order_id
            JOIN order_items oi ON oi.order_id = o.id
            LEFT JOIN package_order_links pol ON pol.order_id = o.id
            LEFT JOIN packages p ON p.id = pol.package_id
            JOIN manual_order_details d ON d.order_id = o.id
            WHERE e.client_event_id = ?
            ORDER BY oi.id, p.id
            LIMIT 1
            """,
            (payload.client_event_id,),
        ).fetchone()
        if replay is not None:
            replay_courier = normalize_courier(replay["courier"] or "")
            if (
                normalize_tracking_no(replay["tracking_no"] or "") != tracking_normalized
                or replay["title"] != product_name
                or replay_courier != courier_normalized
                or replay["remark"] != remark
            ):
                raise HTTPException(status_code=409, detail="client_event_id 已用于其他第三方订单")
            return ManualOrderCreateResponse(
                created=False,
                idempotent_replay=True,
                order_id=str(replay["id"]),
                platform_order_id=replay["platform_order_id"],
                tracking_no=replay["tracking_no"] or tracking_no,
                product_name=replay["title"],
                courier=replay["courier"],
                source="THIRD_PARTY_MANUAL",
            )

        account = connection.execute(
            """
            SELECT id FROM platform_accounts
            WHERE platform = 'other' AND account_key = 'manual'
            """
        ).fetchone()
        if account is None:
            account_id = connection.execute(
                """
                INSERT INTO platform_accounts(
                    platform, account_key, display_label, source,
                    created_at, updated_at
                ) VALUES ('other', 'manual', '第三方/其他渠道', 'MANUAL', ?, ?)
                """,
                (now, now),
            ).lastrowid
        else:
            account_id = account["id"]

        existing_order = connection.execute(
            """
            SELECT o.id, o.platform_order_id, oi.title, d.courier, d.remark
            FROM purchase_orders o
            JOIN order_items oi ON oi.order_id = o.id
            JOIN manual_order_details d ON d.order_id = o.id
            WHERE o.platform_account_id = ? AND o.platform_order_id = ?
            ORDER BY oi.id LIMIT 1
            """,
            (account_id, order_key),
        ).fetchone()
        if existing_order is not None:
            if existing_order["title"] != product_name:
                raise HTTPException(
                    status_code=409,
                    detail="该运单号已经登记过其他商品，请检查物流公司或商品名称",
                )
            raise HTTPException(status_code=409, detail="该运单号已经登记过，请勿重复录入")

        platform_link = connection.execute(
            """
            SELECT pa.platform
            FROM packages p
            JOIN package_order_links l ON l.package_id = p.id
            JOIN purchase_orders o ON o.id = l.order_id
            JOIN platform_accounts pa ON pa.id = o.platform_account_id
            WHERE p.tracking_no_normalized = ? AND pa.platform <> 'other'
            LIMIT 1
            """,
            (tracking_normalized,),
        ).fetchone()
        if platform_link is not None:
            raise HTTPException(
                status_code=409,
                detail="该运单号已属于已同步的平台订单，不能重复登记为第三方订单",
            )

        manual_link = connection.execute(
            """
            SELECT o.id, oi.title, d.courier
            FROM packages p
            JOIN package_order_links l ON l.package_id = p.id
            JOIN purchase_orders o ON o.id = l.order_id
            JOIN order_items oi ON oi.order_id = o.id
            JOIN manual_order_details d ON d.order_id = o.id
            JOIN platform_accounts pa ON pa.id = o.platform_account_id
            WHERE p.tracking_no_normalized = ? AND pa.platform = 'other'
            LIMIT 1
            """,
            (tracking_normalized,),
        ).fetchone()
        if manual_link is not None:
            raise HTTPException(status_code=409, detail="该运单号已经登记过，请勿重复录入")

        package = connection.execute(
            """
            SELECT id, tracking_no, courier
            FROM packages
            WHERE tracking_no_normalized = ?
            ORDER BY id LIMIT 1
            """,
            (tracking_normalized,),
        ).fetchone()
        if package is not None:
            package_id = package["id"]
            if courier and not package["courier"]:
                connection.execute(
                    "UPDATE packages SET courier = ?, courier_normalized = ?, updated_at = ? WHERE id = ?",
                    (courier, courier_normalized, now, package_id),
                )
        else:
            package_id = connection.execute(
                """
                INSERT INTO packages(
                    courier, courier_normalized, tracking_no,
                    tracking_no_normalized, package_status, source,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'MANUAL', 'THIRD_PARTY_MANUAL', ?, ?)
                """,
                (courier, courier_normalized, tracking_no, tracking_normalized, now, now),
            ).lastrowid

        order_id = connection.execute(
            """
            INSERT INTO purchase_orders(
                platform_account_id, platform_order_id, ordered_at,
                order_status, shop_name, source, last_seen_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, 'UNKNOWN', NULL, 'THIRD_PARTY_MANUAL', ?, ?, ?)
            """,
            (account_id, order_key, now, now, now, now),
        ).lastrowid
        connection.execute(
            """
            INSERT INTO order_items(order_id, item_key, title, sku_text, quantity, unit_price)
            VALUES (?, ?, ?, NULL, '1', NULL)
            """,
            (order_id, f"manual:{tracking_normalized}", product_name),
        )
        connection.execute(
            """
            INSERT INTO manual_order_details(
                order_id, courier, remark, created_by_user_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (order_id, courier, remark, user.id, now, now),
        )
        connection.execute(
            """
            INSERT INTO package_order_links(package_id, order_id, order_item_id, created_at)
            VALUES (?, ?, NULL, ?)
            """,
            (package_id, order_id, now),
        )
        connection.execute(
            """
            INSERT INTO manual_order_events(client_event_id, order_id, actor_user_id, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (payload.client_event_id, order_id, user.id, now),
        )
        return ManualOrderCreateResponse(
            created=True,
            idempotent_replay=False,
            order_id=str(order_id),
            platform_order_id=order_key,
            tracking_no=tracking_no,
            product_name=product_name,
            courier=courier,
            source="THIRD_PARTY_MANUAL",
        )

    @application.post(
        "/api/manual-orders",
        response_model=ManualOrderCreateResponse,
        status_code=201,
    )
    def create_manual_order(
        payload: ManualOrderCreate,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> ManualOrderCreateResponse:
        """Register a parcel purchased outside 1688/PDD."""
        database = _database(request)
        now = db_timestamp(utc_now())
        with database.connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                result = persist_manual_order(payload, connection, user, now)
                connection.commit()
                return result
            except HTTPException:
                connection.rollback()
                raise
            except sqlite3.IntegrityError as exc:
                connection.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="该第三方订单已存在，请刷新后重试",
                ) from exc
            except BaseException:
                connection.rollback()
                raise

    def manual_batch_conflict_code(
        *,
        connection: sqlite3.Connection,
        tracking_no_normalized: str,
        client_event_id: str,
    ) -> Literal[
        "PLATFORM_ORDER_EXISTS",
        "MANUAL_ORDER_EXISTS",
        "EVENT_CONFLICT",
        "DATABASE_CONFLICT",
    ]:
        event = connection.execute(
            "SELECT 1 FROM manual_order_events WHERE client_event_id = ?",
            (client_event_id,),
        ).fetchone()
        if event is not None:
            return "EVENT_CONFLICT"
        platforms = connection.execute(
            """
            SELECT DISTINCT pa.platform
            FROM packages p
            JOIN package_order_links l ON l.package_id = p.id
            JOIN purchase_orders o ON o.id = l.order_id
            JOIN platform_accounts pa ON pa.id = o.platform_account_id
            WHERE p.tracking_no_normalized = ?
            """,
            (tracking_no_normalized,),
        ).fetchall()
        if any(row["platform"] != "other" for row in platforms):
            return "PLATFORM_ORDER_EXISTS"
        if platforms:
            return "MANUAL_ORDER_EXISTS"
        return "DATABASE_CONFLICT"

    @application.post(
        "/api/manual-orders/batch",
        response_model=ManualOrderBatchCreateResponse,
        status_code=200,
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": ManualOrderBatchCreate.model_json_schema()
                    }
                },
            }
        },
    )
    def create_manual_orders_batch(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
        payload: Annotated[
            ManualOrderBatchCreate,
            Depends(read_manual_batch_payload),
        ],
    ) -> ManualOrderBatchCreateResponse:
        """Import bounded text or frontend-parsed spreadsheet rows.

        Expected row conflicts are isolated with savepoints, while the batch
        marker and all successful rows commit atomically. A canonical digest
        prevents an idempotency key from being reused with different content
        or by a different user.
        """

        inputs = expand_manual_batch_inputs(payload)
        payload_sha256 = manual_batch_payload_digest(payload)
        now = db_timestamp(utc_now())
        database = _database(request)
        results: list[ManualOrderBatchItemResult] = []
        seen_tracking_numbers: set[str] = set()
        unique_count = 0
        created_count = 0
        idempotent_count = 0
        duplicate_count = 0
        failed_count = 0

        # One write transaction avoids up to 500 SQLite fsync cycles and keeps
        # the accepted batch marker atomic with every successfully handled row.
        with database.connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                existing_batch = connection.execute(
                    """
                    SELECT payload_sha256, actor_user_id, item_count
                    FROM manual_order_batches
                    WHERE client_batch_id = ?
                    """,
                    (payload.client_batch_id,),
                ).fetchone()
                if existing_batch is not None:
                    if existing_batch["actor_user_id"] != user.id:
                        raise HTTPException(
                            status_code=409,
                            detail="client_batch_id 已由其他用户使用",
                        )
                    if (
                        existing_batch["payload_sha256"] != payload_sha256
                        or existing_batch["item_count"] != len(inputs)
                    ):
                        raise HTTPException(
                            status_code=409,
                            detail="client_batch_id 已用于其他批量录入内容",
                        )
                    batch_replay = True
                else:
                    connection.execute(
                        """
                        INSERT INTO manual_order_batches(
                            client_batch_id, payload_sha256, actor_user_id,
                            item_count, created_at
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            payload.client_batch_id,
                            payload_sha256,
                            user.id,
                            len(inputs),
                            now,
                        ),
                    )
                    batch_replay = False

                for raw_item in inputs:
                    item = validate_manual_batch_input(raw_item)
                    if isinstance(item, ManualBatchValidationFailure):
                        failed_count += 1
                        results.append(
                            ManualOrderBatchItemResult(
                                input_index=item.input_index,
                                row_number=item.row_number,
                                tracking_no=item.tracking_no,
                                tracking_no_normalized=item.tracking_no_normalized,
                                status="FAILED",
                                error_code=item.error_code,
                                message=item.message,
                            )
                        )
                        continue

                    if item.tracking_no_normalized in seen_tracking_numbers:
                        duplicate_count += 1
                        results.append(
                            ManualOrderBatchItemResult(
                                input_index=item.input_index,
                                row_number=item.row_number,
                                tracking_no=item.tracking_no,
                                tracking_no_normalized=item.tracking_no_normalized,
                                status="DUPLICATE_INPUT",
                                product_name=item.product_name,
                                courier=item.courier,
                                message="同一批次中的重复运单号已跳过",
                            )
                        )
                        continue

                    seen_tracking_numbers.add(item.tracking_no_normalized)
                    unique_count += 1
                    client_event_id = manual_batch_event_id(
                        payload.client_batch_id,
                        item.tracking_no_normalized,
                    )
                    connection.execute("SAVEPOINT manual_batch_item")
                    try:
                        created = persist_manual_order(
                            ManualOrderCreate(
                                client_event_id=client_event_id,
                                tracking_no=item.tracking_no,
                                product_name=item.product_name,
                                courier=item.courier,
                                remark=item.remark,
                            ),
                            connection,
                            user,
                            now,
                        )
                    except HTTPException as exc:
                        connection.execute("ROLLBACK TO SAVEPOINT manual_batch_item")
                        connection.execute("RELEASE SAVEPOINT manual_batch_item")
                        if exc.status_code != 409:
                            raise
                        failed_count += 1
                        error_code = manual_batch_conflict_code(
                            connection=connection,
                            tracking_no_normalized=item.tracking_no_normalized,
                            client_event_id=client_event_id,
                        )
                        messages = {
                            "PLATFORM_ORDER_EXISTS": "该运单号已属于 1688 或拼多多订单",
                            "MANUAL_ORDER_EXISTS": "该运单号已由其他手工录入创建",
                            "EVENT_CONFLICT": "该批次条目的幂等标识已用于其他内容",
                            "DATABASE_CONFLICT": "该运单号与现有数据冲突",
                        }
                        results.append(
                            ManualOrderBatchItemResult(
                                input_index=item.input_index,
                                row_number=item.row_number,
                                tracking_no=item.tracking_no,
                                tracking_no_normalized=item.tracking_no_normalized,
                                status="FAILED",
                                product_name=item.product_name,
                                courier=item.courier,
                                error_code=error_code,
                                message=messages[error_code],
                            )
                        )
                        continue
                    else:
                        connection.execute("RELEASE SAVEPOINT manual_batch_item")

                    if created.idempotent_replay:
                        idempotent_count += 1
                        item_status = "IDEMPOTENT"
                        message = "该批次条目已处理，本次未重复创建"
                    else:
                        created_count += 1
                        item_status = "CREATED"
                        message = "第三方订单已创建"
                    results.append(
                        ManualOrderBatchItemResult(
                            input_index=item.input_index,
                            row_number=item.row_number,
                            tracking_no=created.tracking_no,
                            tracking_no_normalized=item.tracking_no_normalized,
                            status=item_status,
                            created=created.created,
                            idempotent_replay=created.idempotent_replay,
                            order_id=created.order_id,
                            platform_order_id=created.platform_order_id,
                            product_name=created.product_name,
                            courier=created.courier,
                            message=message,
                        )
                    )

                connection.commit()
            except HTTPException:
                connection.rollback()
                raise
            except BaseException:
                connection.rollback()
                raise

        return ManualOrderBatchCreateResponse(
            client_batch_id=payload.client_batch_id,
            idempotent_replay=batch_replay,
            total_count=len(inputs),
            unique_count=unique_count,
            created_count=created_count,
            idempotent_count=idempotent_count,
            duplicate_count=duplicate_count,
            failed_count=failed_count,
            items=results,
        )

    @application.post("/api/auth/login", response_model=AuthResponse)
    def login(payload: LoginRequest, request: Request, response: Response) -> AuthResponse:
        settings = _settings(request)
        database = _database(request)
        username = payload.username.strip()
        with database.connect() as connection:
            # Login and account activation changes share the same SQLite write
            # lock.  Whichever starts first completes atomically: a later
            # deactivation revokes the just-created session, while a login that
            # starts after deactivation observes the inactive account.
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT id, username, display_name, role, password_hash, is_active,
                       last_login_at
                FROM users WHERE username = ?
                """,
                (username,),
            ).fetchone()
            if (
                row is None
                or not row["is_active"]
                or not verify_password(payload.password, row["password_hash"])
            ):
                connection.rollback()
                raise HTTPException(status_code=401, detail="invalid username or password")

            # Keep this second check next to the session INSERT.  It documents
            # and enforces the invariant even if the authentication work above
            # is later refactored to release/reacquire locks.
            active = connection.execute(
                "SELECT is_active FROM users WHERE id = ?",
                (row["id"],),
            ).fetchone()
            if active is None or not active["is_active"]:
                connection.rollback()
                raise HTTPException(status_code=401, detail="invalid username or password")

            now = utc_now()
            expires_at = now + timedelta(seconds=settings.session_ttl_seconds)
            raw_token = new_session_token()
            connection.execute(
                """
                INSERT INTO sessions(
                    id, user_id, token_digest, created_at, expires_at, last_seen_at,
                    user_agent, ip_address
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid.uuid4().hex,
                    row["id"],
                    session_token_digest(settings.session_secret, raw_token),
                    db_timestamp(now),
                    db_timestamp(expires_at),
                    db_timestamp(now),
                    request.headers.get("user-agent"),
                    request.client.host if request.client else None,
                ),
            )
            connection.execute(
                "UPDATE users SET last_login_at = ? WHERE id = ?",
                (db_timestamp(now), row["id"]),
            )
            connection.commit()

        response.set_cookie(
            key=settings.cookie_name,
            value=raw_token,
            max_age=settings.session_ttl_seconds,
            httponly=True,
            secure=settings.cookie_secure,
            samesite="lax",
            path="/",
        )
        return AuthResponse(
            user=UserOut(
                id=row["id"],
                username=row["username"],
                display_name=row["display_name"],
                role=row["role"],
                last_login_at=now,
            ),
            auth_required=settings.auth_required,
        )

    @application.post(
        "/api/auth/logout", status_code=204, response_class=Response, response_model=None
    )
    def logout(request: Request, response: Response) -> None:
        settings = _settings(request)
        token = request.cookies.get(settings.cookie_name)
        if token:
            with _database(request).connect() as connection:
                connection.execute(
                    """
                    UPDATE sessions SET revoked_at = ?
                    WHERE token_digest = ? AND revoked_at IS NULL
                    """,
                    (
                        db_timestamp(utc_now()),
                        session_token_digest(settings.session_secret, token),
                    ),
                )
                connection.commit()
        response.delete_cookie(
            settings.cookie_name,
            path="/",
            secure=settings.cookie_secure,
            httponly=True,
            samesite="lax",
        )

    @application.get("/api/auth/me", response_model=AuthResponse)
    def current_user(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> AuthResponse:
        return AuthResponse(
            user=user.public(),
            auth_required=_settings(request).auth_required,
        )

    @application.post(
        "/api/auth/change-password",
        status_code=204,
        response_class=Response,
        response_model=None,
    )
    def change_password(
        payload: PasswordChangeRequest,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> None:
        """Change only the authenticated user's password.

        The current session remains valid so the operator is not abruptly
        logged out, while every other session for the account is revoked.
        This also works in trusted-LAN mode, where there is no cookie session
        to preserve.
        """
        if payload.current_password == payload.new_password:
            raise HTTPException(status_code=422, detail="new password must differ from current password")
        _validate_strong_password(payload.new_password)
        database = _database(request)
        timestamp = db_timestamp(utc_now())
        with database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id, password_hash, is_active FROM users WHERE id = ?",
                (user.id,),
            ).fetchone()
            if row is None or not row["is_active"]:
                connection.rollback()
                raise HTTPException(status_code=401, detail="account is no longer active")
            if not verify_password(payload.current_password, row["password_hash"]):
                connection.rollback()
                raise HTTPException(status_code=401, detail="current password is incorrect")
            connection.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(payload.new_password), user.id),
            )
            if user.session_id == "trusted-lan":
                connection.execute(
                    "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
                    (timestamp, user.id),
                )
            else:
                connection.execute(
                    """
                    UPDATE sessions SET revoked_at = ?
                    WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
                    """,
                    (timestamp, user.id, user.session_id),
                )
            connection.commit()

    @application.get("/api/users", response_model=UserListResponse)
    def list_users(
        request: Request,
        admin: Annotated[AuthenticatedUser, Depends(require_admin)],
    ) -> UserListResponse:
        del admin
        with _database(request).connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    users.id,
                    users.username,
                    users.display_name,
                    users.role,
                    users.is_active,
                    MAX(sessions.created_at) AS last_login_at
                FROM users
                LEFT JOIN sessions ON sessions.user_id = users.id
                GROUP BY users.id
                ORDER BY users.is_active DESC,
                         users.display_name COLLATE NOCASE,
                         users.id
                """
            ).fetchall()
        return UserListResponse(
            items=[
                UserOut(
                    id=row["id"],
                    username=row["username"],
                    display_name=row["display_name"],
                    role=row["role"],
                    is_active=bool(row["is_active"]),
                    last_login_at=row["last_login_at"],
                )
                for row in rows
            ],
            total=len(rows),
        )

    @application.post("/api/users", response_model=UserOut, status_code=201)
    def create_user(
        payload: UserCreate,
        request: Request,
        admin: Annotated[AuthenticatedUser, Depends(require_admin)],
    ) -> UserOut:
        username = payload.username.strip()
        display_name = payload.display_name.strip()
        if re.fullmatch(r"[\w.@+-]{3,64}", username, flags=re.UNICODE) is None:
            raise HTTPException(
                status_code=422,
                detail="username may contain letters, numbers, _, ., @, + and -",
            )
        if not display_name:
            raise HTTPException(status_code=422, detail="display_name is required")
        _validate_strong_password(payload.password)
        timestamp = db_timestamp(utc_now())
        password_hash = hash_password(payload.password)
        with _database(request).connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                actor = connection.execute(
                    """
                    SELECT id, username, display_name
                    FROM users
                    WHERE id = ? AND role = 'ADMIN' AND is_active = 1
                    """,
                    (admin.id,),
                ).fetchone()
                if actor is None:
                    connection.rollback()
                    raise HTTPException(
                        status_code=401,
                        detail="administrator session is no longer active",
                    )
                cursor = connection.execute(
                    """
                    INSERT INTO users(
                        username, display_name, role, password_hash,
                        is_active, created_at
                    ) VALUES (?, ?, ?, ?, 1, ?)
                    """,
                    (
                        username,
                        display_name,
                        payload.role,
                        password_hash,
                        timestamp,
                    ),
                )
                user_id = cursor.lastrowid
                connection.execute(
                    """
                    INSERT INTO user_management_events(
                        actor_user_id, actor_username, actor_display_name,
                        target_user_id, target_username, target_display_name,
                        target_role, action, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATE', ?)
                    """,
                    (
                        actor["id"],
                        actor["username"],
                        actor["display_name"],
                        user_id,
                        username,
                        display_name,
                        payload.role,
                        timestamp,
                    ),
                )
                connection.commit()
            except sqlite3.IntegrityError as exc:
                connection.rollback()
                raise HTTPException(status_code=409, detail="username already exists") from exc
        return UserOut(
            id=user_id,
            username=username,
            display_name=display_name,
            role=payload.role,
            is_active=True,
            last_login_at=None,
        )

    @application.get(
        "/api/users/audit-events",
        response_model=UserManagementAuditListResponse,
    )
    def list_user_management_audit_events(
        request: Request,
        admin: Annotated[AuthenticatedUser, Depends(require_admin)],
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> UserManagementAuditListResponse:
        del admin
        with _database(request).connect() as connection:
            total = connection.execute(
                "SELECT COUNT(*) AS count FROM user_management_events"
            ).fetchone()["count"]
            rows = connection.execute(
                """
                SELECT
                    id, actor_user_id, actor_username, actor_display_name,
                    target_user_id, target_username, target_display_name,
                    target_role, action, created_at
                FROM user_management_events
                ORDER BY created_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return UserManagementAuditListResponse(
            items=[UserManagementAuditEventOut(**dict(row)) for row in rows],
            total=total,
            limit=limit,
            offset=offset,
        )

    @application.patch("/api/users/{user_id}", response_model=UserOut)
    def update_user_activation(
        user_id: int,
        payload: UserActivationUpdate,
        request: Request,
        admin: Annotated[AuthenticatedUser, Depends(require_admin)],
    ) -> UserOut:
        with _database(request).connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            actor = connection.execute(
                """
                SELECT id, username, display_name
                FROM users
                WHERE id = ? AND role = 'ADMIN' AND is_active = 1
                """,
                (admin.id,),
            ).fetchone()
            if actor is None:
                connection.rollback()
                raise HTTPException(
                    status_code=401,
                    detail="administrator session is no longer active",
                )
            row = connection.execute(
                """
                SELECT id, username, display_name, role, is_active, last_login_at
                FROM users WHERE id = ?
                """,
                (user_id,),
            ).fetchone()
            if row is None:
                connection.rollback()
                raise HTTPException(status_code=404, detail="user not found")
            if not payload.is_active and user_id == admin.id:
                connection.rollback()
                raise HTTPException(status_code=409, detail="cannot deactivate your own user")
            if not payload.is_active and row["role"] == "ADMIN" and row["is_active"]:
                active_admins = connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM users
                    WHERE role = 'ADMIN' AND is_active = 1
                    """
                ).fetchone()["count"]
                if active_admins <= 1:
                    connection.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="cannot deactivate the last active administrator",
                    )
            if bool(row["is_active"]) != payload.is_active:
                timestamp = db_timestamp(utc_now())
                connection.execute(
                    "UPDATE users SET is_active = ? WHERE id = ?",
                    (int(payload.is_active), user_id),
                )
                if not payload.is_active:
                    connection.execute(
                        """
                        UPDATE sessions SET revoked_at = ?
                        WHERE user_id = ? AND revoked_at IS NULL
                        """,
                        (timestamp, user_id),
                    )
                connection.execute(
                    """
                    INSERT INTO user_management_events(
                        actor_user_id, actor_username, actor_display_name,
                        target_user_id, target_username, target_display_name,
                        target_role, action, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        actor["id"],
                        actor["username"],
                        actor["display_name"],
                        row["id"],
                        row["username"],
                        row["display_name"],
                        row["role"],
                        "ACTIVATE" if payload.is_active else "DEACTIVATE",
                        timestamp,
                    ),
                )
            connection.commit()
        return UserOut(
            id=row["id"],
            username=row["username"],
            display_name=row["display_name"],
            role=row["role"],
            is_active=payload.is_active,
            last_login_at=row["last_login_at"],
        )

    @application.get("/api/dashboard/stats", response_model=DashboardStatsOut)
    def dashboard_stats(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> DashboardStatsOut:
        del user
        with _database(request).connect() as connection:
            row = connection.execute(
                """
                WITH tracking_order_counts AS (
                    SELECT
                        packages.tracking_no_normalized AS tracking_no_normalized,
                        COUNT(DISTINCT links.order_id) AS order_count
                    FROM packages AS packages
                    JOIN package_order_links AS links
                      ON links.package_id = packages.id
                    JOIN purchase_orders AS orders
                      ON orders.id = links.order_id
                    GROUP BY packages.tracking_no_normalized
                ),
                order_tracking AS (
                    SELECT DISTINCT
                        links.order_id AS order_id,
                        packages.tracking_no_normalized AS tracking_no_normalized
                    FROM package_order_links AS links
                    JOIN packages AS packages
                      ON packages.id = links.package_id
                ),
                canonical_receipts AS (
                    SELECT id, tracking_no_normalized
                    FROM receipt_events
                    WHERE evidence_status = 'READY'
                      AND duplicate_of_receipt_id IS NULL
                ),
                order_arrival_metrics AS (
                    SELECT
                        order_tracking.order_id AS order_id,
                        COUNT(DISTINCT order_tracking.tracking_no_normalized)
                            AS package_count,
                        COUNT(
                            DISTINCT CASE
                                WHEN receipts.id IS NOT NULL
                                 AND tracking_order_counts.order_count = 1
                                THEN order_tracking.tracking_no_normalized
                            END
                        ) AS arrived_package_count,
                        COUNT(
                            DISTINCT CASE
                                WHEN receipts.id IS NOT NULL
                                 AND tracking_order_counts.order_count > 1
                                THEN order_tracking.tracking_no_normalized
                            END
                        ) AS candidate_package_count
                    FROM order_tracking
                    LEFT JOIN tracking_order_counts
                      ON tracking_order_counts.tracking_no_normalized =
                         order_tracking.tracking_no_normalized
                    LEFT JOIN canonical_receipts AS receipts
                      ON receipts.tracking_no_normalized =
                         order_tracking.tracking_no_normalized
                    GROUP BY order_tracking.order_id
                ),
                order_effective_arrivals AS (
                    SELECT
                        orders.id AS order_id,
                        CASE
                            WHEN UPPER(TRIM(orders.order_status))
                                 IN ('CANCELLED', 'REFUNDED')
                            THEN 'CLOSED'
                            ELSE COALESCE(
                                overrides.status,
                                CASE
                                WHEN COALESCE(metrics.package_count, 0) > 0
                                 AND COALESCE(metrics.arrived_package_count, 0) >=
                                     COALESCE(metrics.package_count, 0)
                                THEN 'RECEIVED'
                                WHEN (
                                    COALESCE(metrics.arrived_package_count, 0) > 0
                                    AND COALESCE(metrics.arrived_package_count, 0) <
                                        COALESCE(metrics.package_count, 0)
                                ) OR COALESCE(metrics.candidate_package_count, 0) > 0
                                THEN 'REVIEW'
                                    ELSE 'PENDING'
                                END
                            )
                        END AS effective_arrival_status
                    FROM purchase_orders AS orders
                    LEFT JOIN order_arrival_metrics AS metrics
                      ON metrics.order_id = orders.id
                    LEFT JOIN order_arrival_overrides AS overrides
                      ON overrides.order_id = orders.id
                ),
                ready_receipt_links AS (
                    SELECT DISTINCT
                        receipts.id AS receipt_id,
                        links.order_id AS order_id,
                        tracking_order_counts.order_count AS order_count
                    FROM receipt_events AS receipts
                    JOIN packages AS packages
                      ON packages.tracking_no_normalized = receipts.tracking_no_normalized
                    JOIN package_order_links AS links
                      ON links.package_id = packages.id
                    JOIN purchase_orders AS orders
                      ON orders.id = links.order_id
                    JOIN tracking_order_counts
                      ON tracking_order_counts.tracking_no_normalized =
                         receipts.tracking_no_normalized
                    WHERE receipts.evidence_status = 'READY'
                      AND receipts.duplicate_of_receipt_id IS NULL
                )
                SELECT
                    (SELECT COUNT(*) FROM purchase_orders) AS total_orders,
                    (
                        SELECT COUNT(*) FROM receipt_events
                        WHERE evidence_status = 'READY'
                          AND duplicate_of_receipt_id IS NULL
                    ) AS arrival_photos,
                    (
                        SELECT COUNT(DISTINCT order_id)
                        FROM ready_receipt_links
                        WHERE order_count = 1
                    ) AS matched_orders,
                    (
                        SELECT COUNT(*)
                        FROM purchase_orders AS orders
                        JOIN order_effective_arrivals AS arrivals
                          ON arrivals.order_id = orders.id
                        WHERE arrivals.effective_arrival_status = 'RECEIVED'
                    ) AS received_orders,
                    (
                        SELECT COUNT(*)
                        FROM purchase_orders AS orders
                        JOIN order_effective_arrivals AS arrivals
                          ON arrivals.order_id = orders.id
                        WHERE arrivals.effective_arrival_status = 'REVIEW'
                    ) AS review_orders,
                    (
                        SELECT COUNT(*)
                        FROM purchase_orders AS orders
                        JOIN order_effective_arrivals AS arrivals
                          ON arrivals.order_id = orders.id
                        WHERE UPPER(TRIM(orders.order_status))
                                  NOT IN ('CANCELLED', 'REFUNDED')
                          AND arrivals.effective_arrival_status = 'PENDING'
                    ) AS pending_orders,
                    (
                        SELECT COUNT(DISTINCT order_id)
                        FROM ready_receipt_links
                    ) AS linked_orders,
                    (
                        SELECT COUNT(DISTINCT receipt_id)
                        FROM ready_receipt_links
                        WHERE order_count > 1
                    ) AS candidate_photos,
                    (
                        SELECT COUNT(*) FROM receipt_events AS receipts
                        WHERE receipts.evidence_status = 'READY'
                          AND receipts.duplicate_of_receipt_id IS NULL
                          AND NOT EXISTS (
                              SELECT 1 FROM ready_receipt_links
                              WHERE ready_receipt_links.receipt_id = receipts.id
                          )
                    ) AS unmatched_photos,
                    (SELECT COUNT(*) FROM platform_accounts WHERE platform <> 'other') AS account_count
                """
            ).fetchone()

        total_orders = row["total_orders"]
        matched_orders = row["matched_orders"]
        unlinked_orders = max(total_orders - matched_orders, 0)
        return DashboardStatsOut(
            total_orders=total_orders,
            arrival_photos=row["arrival_photos"],
            matched_orders=matched_orders,
            received_orders=row["received_orders"],
            review_orders=row["review_orders"],
            linked_orders=row["linked_orders"],
            candidate_photos=row["candidate_photos"],
            unlinked_orders=unlinked_orders,
            pending_orders=row["pending_orders"],
            unmatched_photos=row["unmatched_photos"],
            account_count=row["account_count"],
        )

    @application.get("/api/orders", response_model=PurchaseOrderListResponse)
    def list_orders(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
        offset: Annotated[int, Query(ge=0)] = 0,
        query: Annotated[str | None, Query(max_length=128)] = None,
        platform: Annotated[Literal["pdd", "1688", "other"] | None, Query()] = None,
        arrival_status: Annotated[
            Literal["all", "pending", "review", "received"], Query()
        ] = "all",
    ) -> PurchaseOrderListResponse:
        del user
        filters: list[str] = []
        parameters: dict[str, str | int] = {}
        if platform is not None:
            filters.append("accounts.platform = :platform")
            parameters["platform"] = platform

        search = query.strip() if query is not None else ""
        if search:
            parameters["query"] = search
            search_clauses = [
                "instr(lower(orders.platform_order_id), lower(:query)) > 0",
                "instr(lower(COALESCE(orders.shop_name, '')), lower(:query)) > 0",
                """
                instr(
                    lower(
                        COALESCE(
                            NULLIF(TRIM(accounts.display_label), ''),
                            '账号 ' || accounts.id
                        )
                    ),
                    lower(:query)
                ) > 0
                """,
                "instr(lower(accounts.account_key), lower(:query)) > 0",
                "instr(lower(accounts.platform), lower(:query)) > 0",
                "instr(lower(orders.order_status), lower(:query)) > 0",
                """
                EXISTS (
                    SELECT 1 FROM order_items AS searched_items
                    WHERE searched_items.order_id = orders.id
                      AND (
                          instr(lower(searched_items.title), lower(:query)) > 0
                          OR instr(
                              lower(COALESCE(searched_items.sku_text, '')),
                              lower(:query)
                          ) > 0
                      )
                )
                """,
                """
                EXISTS (
                    SELECT 1
                    FROM package_order_links AS searched_links
                    JOIN packages AS searched_packages
                      ON searched_packages.id = searched_links.package_id
                    WHERE searched_links.order_id = orders.id
                      AND (
                          instr(
                              lower(searched_packages.tracking_no), lower(:query)
                          ) > 0
                          OR instr(
                              lower(COALESCE(searched_packages.courier, '')),
                              lower(:query)
                          ) > 0
                      )
                )
                """,
            ]
            normalized_search = normalize_tracking_no(search)
            if (
                re.fullmatch(r"[A-Za-z0-9 -]+", search) is not None
                and len(normalized_search) >= 6
            ):
                parameters["tracking_query"] = normalized_search
                search_clauses.append(
                    """
                    EXISTS (
                        SELECT 1
                        FROM package_order_links AS normalized_links
                        JOIN packages AS normalized_packages
                          ON normalized_packages.id = normalized_links.package_id
                        WHERE normalized_links.order_id = orders.id
                          AND instr(
                              normalized_packages.tracking_no_normalized,
                              :tracking_query
                          ) > 0
                    )
                    """
                )
            filters.append("(" + " OR ".join(search_clauses) + ")")

        if arrival_status == "received":
            filters.append("arrival_states.effective_arrival_status = 'RECEIVED'")
        elif arrival_status == "review":
            filters.append("arrival_states.effective_arrival_status = 'REVIEW'")
        elif arrival_status == "pending":
            filters.append(
                """
                UPPER(TRIM(orders.order_status)) NOT IN ('CANCELLED', 'REFUNDED')
                AND arrival_states.effective_arrival_status = 'PENDING'
                """
            )

        where_sql = " AND ".join(filters) if filters else "1 = 1"
        sync_parameters: dict[str, str | None] = {"sync_platform": platform}
        order_metrics_ctes = """
            canonical_receipts AS (
                SELECT
                    receipts.id,
                    receipts.tracking_no_normalized,
                    receipts.operator_user_id AS responsible_user_id,
                    receipts.server_received_at AS responsibility_at
                FROM receipt_events AS receipts
                WHERE receipts.evidence_status = 'READY'
                  AND receipts.duplicate_of_receipt_id IS NULL
            ),
            tracking_order_counts AS (
                SELECT
                    order_packages.tracking_no_normalized,
                    COUNT(DISTINCT links.order_id) AS order_count
                FROM packages AS order_packages
                JOIN package_order_links AS links
                  ON links.package_id = order_packages.id
                GROUP BY order_packages.tracking_no_normalized
            ),
            order_tracking AS (
                SELECT DISTINCT
                    links.order_id,
                    order_packages.tracking_no_normalized
                FROM package_order_links AS links
                JOIN packages AS order_packages
                  ON order_packages.id = links.package_id
            ),
            order_arrival_metrics AS (
                SELECT
                    order_tracking.order_id AS order_id,
                    COUNT(DISTINCT order_tracking.tracking_no_normalized)
                        AS package_count,
                    COUNT(
                        DISTINCT CASE
                            WHEN receipts.id IS NOT NULL
                             AND tracking_order_counts.order_count = 1
                            THEN order_tracking.tracking_no_normalized
                        END
                    ) AS arrived_package_count,
                    COUNT(
                        DISTINCT CASE
                            WHEN receipts.id IS NOT NULL
                             AND tracking_order_counts.order_count > 1
                            THEN order_tracking.tracking_no_normalized
                        END
                    ) AS candidate_package_count,
                    COUNT(
                        DISTINCT CASE
                            WHEN tracking_order_counts.order_count = 1
                            THEN receipts.id
                        END
                    ) AS arrival_photo_count,
                    COUNT(
                        DISTINCT CASE
                            WHEN tracking_order_counts.order_count > 1
                            THEN receipts.id
                        END
                    ) AS candidate_photo_count
                FROM order_tracking
                LEFT JOIN tracking_order_counts
                  ON tracking_order_counts.tracking_no_normalized =
                     order_tracking.tracking_no_normalized
                LEFT JOIN canonical_receipts AS receipts
                  ON receipts.tracking_no_normalized =
                     order_tracking.tracking_no_normalized
                GROUP BY order_tracking.order_id
            ),
            order_receipt_candidates AS (
                SELECT
                    links.order_id AS order_id,
                    receipts.responsible_user_id AS responsible_user_id,
                    receipts.responsibility_at AS responsibility_at,
                    ROW_NUMBER() OVER (
                        PARTITION BY links.order_id
                        ORDER BY receipts.responsibility_at DESC, receipts.id DESC
                    ) AS receipt_rank
                FROM canonical_receipts AS receipts
                JOIN packages AS receipt_packages
                  ON receipt_packages.tracking_no_normalized =
                     receipts.tracking_no_normalized
                JOIN package_order_links AS links
                  ON links.package_id = receipt_packages.id
            ),
            latest_order_receipts AS (
                SELECT order_id, responsible_user_id, responsibility_at
                FROM order_receipt_candidates
                WHERE receipt_rank = 1
            ),
            order_evidence_states AS (
                SELECT
                    state_orders.id AS order_id,
                    state_orders.order_status AS order_status,
                    state_orders.updated_at AS order_updated_at,
                    COALESCE(metrics.package_count, 0) AS package_count,
                    COALESCE(metrics.arrived_package_count, 0)
                        AS arrived_package_count,
                    COALESCE(metrics.candidate_package_count, 0)
                        AS candidate_package_count,
                    COALESCE(metrics.arrival_photo_count, 0)
                        AS arrival_photo_count,
                    COALESCE(metrics.candidate_photo_count, 0)
                        AS candidate_photo_count,
                    CASE
                        WHEN COALESCE(metrics.package_count, 0) > 0
                         AND COALESCE(metrics.arrived_package_count, 0) >=
                             COALESCE(metrics.package_count, 0)
                        THEN 'RECEIVED'
                        WHEN (
                            COALESCE(metrics.arrived_package_count, 0) > 0
                            AND COALESCE(metrics.arrived_package_count, 0) <
                                COALESCE(metrics.package_count, 0)
                        ) OR COALESCE(metrics.candidate_package_count, 0) > 0
                        THEN 'REVIEW'
                        ELSE 'PENDING'
                    END AS evidence_arrival_status
                FROM purchase_orders AS state_orders
                LEFT JOIN order_arrival_metrics AS metrics
                  ON metrics.order_id = state_orders.id
            ),
            order_arrival_states AS (
                SELECT
                    evidence.*,
                    CASE
                        WHEN UPPER(TRIM(evidence.order_status))
                             IN ('CANCELLED', 'REFUNDED')
                        THEN 'CLOSED'
                        ELSE COALESCE(
                            overrides.status,
                            evidence.evidence_arrival_status
                        )
                    END AS effective_arrival_status,
                    CASE
                        WHEN UPPER(TRIM(evidence.order_status))
                             IN ('CANCELLED', 'REFUNDED')
                        THEN 'AUTO'
                        WHEN overrides.order_id IS NULL THEN 'AUTO'
                        ELSE 'MANUAL'
                    END AS arrival_source,
                    COALESCE(overrides.revision, 0) AS manual_revision,
                    CASE
                        WHEN UPPER(TRIM(evidence.order_status))
                             IN ('CANCELLED', 'REFUNDED')
                        THEN NULL
                        WHEN overrides.order_id IS NULL
                        THEN latest_receipts.responsible_user_id
                        ELSE overrides.actor_user_id
                    END AS responsible_user_id,
                    CASE
                        WHEN UPPER(TRIM(evidence.order_status))
                             IN ('CANCELLED', 'REFUNDED')
                        THEN evidence.order_updated_at
                        WHEN overrides.order_id IS NULL
                        THEN latest_receipts.responsibility_at
                        ELSE overrides.changed_at
                    END AS changed_at
                FROM order_evidence_states AS evidence
                LEFT JOIN order_arrival_overrides AS overrides
                  ON overrides.order_id = evidence.order_id
                LEFT JOIN latest_order_receipts AS latest_receipts
                  ON latest_receipts.order_id = evidence.order_id
            )
        """
        with _database(request).connect() as connection:
            connection.execute("BEGIN")
            last_synced_at = connection.execute(
                """
                WITH registered_accounts AS (
                    SELECT platform, account_key
                    FROM platform_accounts
                    WHERE platform <> 'other'

                    UNION

                    SELECT platform, account_key
                    FROM sync_batches

                    UNION

                    SELECT '1688' AS platform, account_key
                    FROM ali1688_sync_state
                ),
                successful_account_syncs AS (
                    SELECT platform, account_key, received_at AS synced_at
                    FROM sync_batches
                    WHERE status = 'OK'
                      AND NOT (
                          platform = '1688'
                          AND worker_id = 'ali1688-api'
                          AND token_digest = 'ali1688-api'
                      )

                    UNION ALL

                    SELECT '1688' AS platform, account_key, finished_at AS synced_at
                    FROM ali1688_sync_runs
                    WHERE status = 'OK'
                      AND finished_at IS NOT NULL
                ),
                account_freshness AS (
                    SELECT
                        accounts.platform AS platform,
                        accounts.account_key AS account_key,
                        MAX(successful_account_syncs.synced_at) AS synced_at
                    FROM registered_accounts AS accounts
                    LEFT JOIN successful_account_syncs
                      ON successful_account_syncs.platform = accounts.platform
                     AND successful_account_syncs.account_key = accounts.account_key
                    WHERE :sync_platform IS NULL
                       OR accounts.platform = :sync_platform
                    GROUP BY accounts.platform, accounts.account_key
                )
                SELECT CASE
                    WHEN COUNT(*) = 0 OR COUNT(synced_at) < COUNT(*) THEN NULL
                    ELSE MIN(synced_at)
                END AS last_synced_at
                FROM account_freshness
                """,
                sync_parameters,
            ).fetchone()["last_synced_at"]
            total = connection.execute(
                f"""
                WITH {order_metrics_ctes}
                SELECT COUNT(*) AS count
                FROM purchase_orders AS orders
                JOIN platform_accounts AS accounts
                  ON accounts.id = orders.platform_account_id
                JOIN order_arrival_states AS arrival_states
                  ON arrival_states.order_id = orders.id
                WHERE {where_sql}
                """,
                parameters,
            ).fetchone()["count"]

            page_parameters = {**parameters, "limit": limit, "offset": offset}
            order_rows = connection.execute(
                f"""
                WITH {order_metrics_ctes}
                SELECT
                    orders.id AS id,
                    accounts.platform AS platform,
                    COALESCE(
                        NULLIF(TRIM(accounts.display_label), ''),
                        '账号 ' || accounts.id
                    ) AS account_label,
                    orders.platform_order_id AS platform_order_id,
                    orders.ordered_at AS ordered_at,
                    orders.order_status AS order_status,
                    orders.shop_name AS shop_name,
                    orders.source AS source,
                    arrival_states.package_count AS package_count,
                    arrival_states.arrived_package_count AS arrived_package_count,
                    arrival_states.candidate_package_count AS candidate_package_count,
                    arrival_states.arrival_photo_count AS arrival_photo_count,
                    arrival_states.candidate_photo_count AS candidate_photo_count,
                    arrival_states.evidence_arrival_status
                        AS evidence_arrival_status,
                    arrival_states.effective_arrival_status
                        AS effective_arrival_status,
                    arrival_states.arrival_source AS arrival_source,
                    arrival_states.manual_revision AS manual_revision,
                    arrival_states.changed_at AS changed_at,
                    responsible.id AS responsible_user_id,
                    responsible.username AS responsible_username,
                    responsible.display_name AS responsible_display_name,
                    responsible.role AS responsible_role,
                    responsible.is_active AS responsible_is_active,
                    manual_creator.id AS manual_creator_id,
                    manual_creator.username AS manual_creator_username,
                    manual_creator.display_name AS manual_creator_display_name,
                    manual_creator.role AS manual_creator_role,
                    manual_creator.is_active AS manual_creator_is_active,
                    manual_details.created_at AS manual_created_at,
                    manual_details.remark AS manual_remark
                FROM purchase_orders AS orders
                JOIN platform_accounts AS accounts
                  ON accounts.id = orders.platform_account_id
                JOIN order_arrival_states AS arrival_states
                  ON arrival_states.order_id = orders.id
                LEFT JOIN users AS responsible
                  ON responsible.id = arrival_states.responsible_user_id
                LEFT JOIN manual_order_details AS manual_details
                  ON manual_details.order_id = orders.id
                LEFT JOIN users AS manual_creator
                  ON manual_creator.id = manual_details.created_by_user_id
                WHERE {where_sql}
                ORDER BY orders.ordered_at DESC, orders.id DESC
                LIMIT :limit OFFSET :offset
                """,
                page_parameters,
            ).fetchall()

            order_ids = [row["id"] for row in order_rows]
            item_rows: list[sqlite3.Row] = []
            package_rows: list[sqlite3.Row] = []
            if order_ids:
                placeholders = ",".join("?" for _ in order_ids)
                item_rows = connection.execute(
                    f"""
                    SELECT order_id, title, sku_text, quantity, unit_price
                    FROM order_items
                    WHERE order_id IN ({placeholders})
                    ORDER BY order_id, id
                    """,
                    order_ids,
                ).fetchall()
                package_rows = connection.execute(
                    f"""
                    WITH canonical_receipt_tracking AS (
                        SELECT tracking_no_normalized, COUNT(*) AS photo_count
                        FROM receipt_events
                        WHERE evidence_status = 'READY'
                          AND duplicate_of_receipt_id IS NULL
                          AND tracking_no_normalized IS NOT NULL
                        GROUP BY tracking_no_normalized
                    ),
                    tracking_order_counts AS (
                        SELECT
                            order_packages.tracking_no_normalized,
                            COUNT(DISTINCT links.order_id) AS order_count
                        FROM packages AS order_packages
                        JOIN package_order_links AS links
                          ON links.package_id = order_packages.id
                        GROUP BY order_packages.tracking_no_normalized
                    ),
                    ranked_order_tracking AS (
                        SELECT
                            links.order_id,
                            order_packages.tracking_no_normalized,
                            order_packages.id AS representative_package_id,
                            ROW_NUMBER() OVER (
                                PARTITION BY
                                    links.order_id,
                                    order_packages.tracking_no_normalized
                                ORDER BY
                                    order_packages.updated_at DESC,
                                    CASE WHEN order_packages.courier IS NULL
                                        THEN 0 ELSE 1 END DESC,
                                    CASE WHEN order_packages.package_status IS NULL
                                        THEN 0 ELSE 1 END DESC,
                                    order_packages.id DESC
                            ) AS representative_rank
                        FROM package_order_links AS links
                        JOIN packages AS order_packages
                          ON order_packages.id = links.package_id
                        WHERE links.order_id IN ({placeholders})
                    ),
                    order_tracking AS (
                        SELECT
                            order_id,
                            tracking_no_normalized,
                            representative_package_id
                        FROM ranked_order_tracking
                        WHERE representative_rank = 1
                    )
                    SELECT
                        order_tracking.order_id AS order_id,
                        order_packages.id AS package_id,
                        order_packages.courier AS courier,
                        order_packages.tracking_no AS tracking_no,
                        order_packages.package_status AS package_status,
                        CASE
                            WHEN canonical_receipt_tracking.tracking_no_normalized IS NULL
                            THEN 'PENDING'
                            WHEN tracking_order_counts.order_count = 1
                            THEN 'ARRIVED'
                            ELSE 'CANDIDATE'
                        END AS arrival_status
                    FROM order_tracking
                    JOIN packages AS order_packages
                      ON order_packages.id =
                         order_tracking.representative_package_id
                    JOIN tracking_order_counts
                      ON tracking_order_counts.tracking_no_normalized =
                         order_tracking.tracking_no_normalized
                    LEFT JOIN canonical_receipt_tracking
                      ON canonical_receipt_tracking.tracking_no_normalized =
                         order_tracking.tracking_no_normalized
                    ORDER BY
                        order_tracking.order_id,
                        order_tracking.representative_package_id
                    """,
                    order_ids,
                ).fetchall()

        items_by_order: dict[int, list[dict[str, str | None]]] = {
            order_id: [] for order_id in order_ids
        }
        for item in item_rows:
            items_by_order[item["order_id"]].append(
                {
                    "title": item["title"],
                    "sku_text": item["sku_text"],
                    "quantity": item["quantity"],
                    "unit_price": item["unit_price"],
                }
            )

        packages_by_order: dict[int, list[dict[str, str | bool | None]]] = {
            order_id: [] for order_id in order_ids
        }
        for package in package_rows:
            packages_by_order[package["order_id"]].append(
                {
                    "courier": package["courier"],
                    "tracking_no": package["tracking_no"],
                    "package_status": package["package_status"],
                    "arrival_status": package["arrival_status"],
                    "arrived": package["arrival_status"] == "ARRIVED",
                }
            )

        return PurchaseOrderListResponse(
            items=[
                PurchaseOrderOut(
                    id=str(row["id"]),
                    platform=row["platform"],
                    account_label=row["account_label"],
                    platform_order_id=row["platform_order_id"],
                    ordered_at=row["ordered_at"],
                    order_status=row["order_status"],
                    shop_name=row["shop_name"],
                    source=row["source"],
                    items=items_by_order[row["id"]],
                    packages=packages_by_order[row["id"]],
                    package_count=row["package_count"],
                    arrived_package_count=row["arrived_package_count"],
                    candidate_package_count=row["candidate_package_count"],
                    arrival_photo_count=row["arrival_photo_count"],
                    candidate_photo_count=row["candidate_photo_count"],
                    effective_arrival_status=row["effective_arrival_status"],
                    evidence_arrival_status=row["evidence_arrival_status"],
                    arrival_source=row["arrival_source"],
                    responsible_user=(
                        UserOut(
                            id=row["responsible_user_id"],
                            username=row["responsible_username"],
                            display_name=row["responsible_display_name"],
                            role=row["responsible_role"],
                            is_active=bool(row["responsible_is_active"]),
                        )
                        if row["responsible_user_id"] is not None
                        else None
                    ),
                    manual_revision=row["manual_revision"],
                    changed_at=row["changed_at"],
                    manual_created_by=(
                        UserOut(
                            id=row["manual_creator_id"],
                            username=row["manual_creator_username"],
                            display_name=row["manual_creator_display_name"],
                            role=row["manual_creator_role"],
                            is_active=bool(row["manual_creator_is_active"]),
                        )
                        if row["manual_creator_id"] is not None
                        else None
                    ),
                    manual_created_at=row["manual_created_at"],
                    manual_remark=row["manual_remark"],
                )
                for row in order_rows
            ],
            total=total,
            limit=limit,
            offset=offset,
            last_synced_at=last_synced_at,
        )

    @application.patch(
        "/api/orders/{order_id}/arrival-status",
        response_model=OrderArrivalStateOut,
    )
    def update_order_arrival_status(
        order_id: int,
        payload: OrderArrivalStatusUpdate,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> OrderArrivalStateOut:
        client_event_id = _validate_form_text(
            "client_event_id", payload.client_event_id, minimum=8, maximum=128
        )
        reason = payload.reason.strip() if payload.reason is not None else None
        reason = reason or None
        database = _database(request)
        with database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            replay = connection.execute(
                """
                SELECT
                    id, order_id, new_override_status, reason,
                    previous_revision, new_revision
                FROM order_arrival_events
                WHERE client_event_id = ?
                """,
                (client_event_id,),
            ).fetchone()
            if replay is not None:
                if (
                    replay["order_id"] != order_id
                    or replay["new_override_status"] != payload.status
                    or replay["reason"] != reason
                    or replay["previous_revision"] != payload.expected_revision
                ):
                    connection.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="client_event_id was already used for another change",
                    )
                state_out = _fetch_order_arrival_state(
                    connection,
                    order_id,
                    audit_event_id=replay["id"],
                    idempotent_replay=True,
                )
                if state_out is None:
                    connection.rollback()
                    raise HTTPException(status_code=404, detail="order not found")
                if state_out.manual_revision != replay["new_revision"]:
                    connection.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="order changed after the original request; refresh before retrying",
                    )
                if state_out.effective_arrival_status == "CLOSED":
                    connection.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="closed orders cannot be manually marked as received or pending",
                    )
                connection.rollback()
                return state_out

            current = _fetch_order_arrival_state(connection, order_id)
            if current is None:
                connection.rollback()
                raise HTTPException(status_code=404, detail="order not found")
            if current.effective_arrival_status == "CLOSED":
                connection.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="closed orders cannot be manually marked as received or pending",
                )
            if current.manual_revision != payload.expected_revision:
                connection.rollback()
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "arrival status changed concurrently; reload the order "
                        f"(current revision {current.manual_revision})"
                    ),
                )

            previous_override = connection.execute(
                """
                SELECT status, revision
                FROM order_arrival_overrides WHERE order_id = ?
                """,
                (order_id,),
            ).fetchone()
            previous_override_status = (
                previous_override["status"] if previous_override is not None else None
            )
            new_revision = current.manual_revision + 1
            changed_at = db_timestamp(utc_now())
            connection.execute(
                """
                INSERT INTO order_arrival_overrides(
                    order_id, status, revision, actor_user_id, reason, changed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(order_id) DO UPDATE SET
                    status = excluded.status,
                    revision = excluded.revision,
                    actor_user_id = excluded.actor_user_id,
                    reason = excluded.reason,
                    changed_at = excluded.changed_at
                """,
                (
                    order_id,
                    payload.status,
                    new_revision,
                    user.id,
                    reason,
                    changed_at,
                ),
            )
            cursor = connection.execute(
                """
                INSERT INTO order_arrival_events(
                    client_event_id, order_id, actor_user_id, action,
                    previous_effective_status, new_effective_status,
                    previous_override_status, new_override_status,
                    previous_revision, new_revision, reason, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    client_event_id,
                    order_id,
                    user.id,
                    "MARK_RECEIVED" if payload.status == "RECEIVED" else "MARK_PENDING",
                    current.effective_arrival_status,
                    payload.status,
                    previous_override_status,
                    payload.status,
                    current.manual_revision,
                    new_revision,
                    reason,
                    changed_at,
                ),
            )
            audit_event_id = cursor.lastrowid
            connection.commit()
            state_out = _fetch_order_arrival_state(
                connection,
                order_id,
                audit_event_id=audit_event_id,
            )
        if state_out is None:
            raise HTTPException(status_code=404, detail="order not found")
        return state_out

    @application.get(
        "/api/orders/{order_id}/arrival-history",
        response_model=OrderArrivalAuditListResponse,
    )
    def order_arrival_history(
        order_id: int,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> OrderArrivalAuditListResponse:
        del user
        with _database(request).connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM purchase_orders WHERE id = ?", (order_id,)
            ).fetchone()
            if exists is None:
                raise HTTPException(status_code=404, detail="order not found")
            total = connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM order_arrival_events WHERE order_id = ?
                """,
                (order_id,),
            ).fetchone()["count"]
            rows = connection.execute(
                """
                SELECT
                    events.*,
                    actors.username AS actor_username,
                    actors.display_name AS actor_display_name,
                    actors.role AS actor_role,
                    actors.is_active AS actor_is_active
                FROM order_arrival_events AS events
                JOIN users AS actors ON actors.id = events.actor_user_id
                WHERE events.order_id = ?
                ORDER BY events.id DESC
                LIMIT ? OFFSET ?
                """,
                (order_id, limit, offset),
            ).fetchall()
        return OrderArrivalAuditListResponse(
            items=[_arrival_audit_from_row(row) for row in rows],
            total=total,
            limit=limit,
            offset=offset,
        )

    @application.post(
        "/api/receipts",
        response_model=ReceiptCreateResponse,
        status_code=201,
    )
    async def create_receipt(
        request: Request,
        response: Response,
        photo: Annotated[UploadFile, File(...)],
        client_event_id: Annotated[str, Form(...)],
        device_id: Annotated[str, Form(...)],
        user: Annotated[AuthenticatedUser, Depends(require_user)],
        captured_at: Annotated[str | None, Form()] = None,
        occurred_at: Annotated[str | None, Form()] = None,
        tracking_no: Annotated[str | None, Form()] = None,
        barcode_candidate: Annotated[str | None, Form()] = None,
        input_method: Annotated[str, Form()] = "PHOTO_CAPTURE",
    ) -> ReceiptCreateResponse:
        client_event_id = _validate_form_text(
            "client_event_id", client_event_id, minimum=8, maximum=128
        )
        device_id = _validate_form_text("device_id", device_id, minimum=1, maximum=128)
        if input_method not in {"PHOTO_CAPTURE", "PHOTO_LIBRARY"}:
            raise HTTPException(status_code=422, detail="unsupported input_method")
        capture_value = captured_at or occurred_at
        if not capture_value:
            raise HTTPException(status_code=422, detail="captured_at is required")
        captured = parse_client_timestamp(capture_value)
        if barcode_candidate is not None:
            barcode_candidate = barcode_candidate.strip()[:256] or None
        if tracking_no is not None:
            tracking_no = tracking_no.strip()[:128] or None
        normalized_tracking = normalize_tracking_no(tracking_no) if tracking_no else None
        if tracking_no and not normalized_tracking:
            raise HTTPException(status_code=422, detail="tracking_no has no letters or digits")

        database = _database(request)
        with database.connect() as connection:
            existing = _fetch_receipt(connection, client_event_id=client_event_id)
        if existing is not None:
            await photo.close()
            response.status_code = 200
            with database.connect() as connection:
                replayed = _receipt_from_row(connection, existing)
            return ReceiptCreateResponse(
                created=False,
                idempotent_replay=True,
                receipt=replayed,
            )

        settings = _settings(request)
        (
            temporary_path,
            content_type,
            extension,
            photo_size,
            photo_sha256,
        ) = await write_validated_upload(photo, settings)
        received = utc_now()
        relative_dir = Path(received.strftime("%Y/%m"))
        destination_dir = settings.media_dir / relative_dir
        destination_dir.mkdir(parents=True, exist_ok=True)
        destination_name = f"{uuid.uuid4().hex}{extension}"
        destination_path = destination_dir / destination_name
        relative_path = (relative_dir / destination_name).as_posix()
        moved = False

        try:
            os.replace(temporary_path, destination_path)
            moved = True
            # Local BarcodeDetector/ZXing remains the fast path.  Only photos
            # without a client result use the optional, free GLM-V fallback.
            if normalized_tracking is None and settings.zhipu_vl_api_key.strip():
                candidates = await asyncio.to_thread(
                    extract_tracking_candidates,
                    destination_path,
                    api_key=settings.zhipu_vl_api_key,
                    model=settings.zhipu_vl_model,
                    timeout_seconds=settings.zhipu_vl_timeout_seconds,
                )
                if candidates:
                    with database.connect() as candidate_connection:
                        resolved = resolve_tracking_candidate(candidate_connection, candidates)
                    if resolved is not None:
                        tracking_no, normalized_tracking = resolved

            with database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                existing = _fetch_receipt(connection, client_event_id=client_event_id)
                if existing is not None:
                    connection.rollback()
                    temporary_path.unlink(missing_ok=True)
                    destination_path.unlink(missing_ok=True)
                    response.status_code = 200
                    return ReceiptCreateResponse(
                        created=False,
                        idempotent_replay=True,
                        receipt=_receipt_from_row(connection, existing),
                    )

                timestamp = db_timestamp(received)
                duplicate_of_id = None
                if normalized_tracking:
                    duplicate_row = connection.execute(
                        """
                        SELECT id FROM receipt_events
                        WHERE tracking_no_normalized = ? AND evidence_status = 'READY'
                        ORDER BY server_received_at ASC, id ASC
                        LIMIT 1
                        """,
                        (normalized_tracking,),
                    ).fetchone()
                    if duplicate_row is not None:
                        duplicate_of_id = duplicate_row["id"]
                cursor = connection.execute(
                    """
                    INSERT INTO receipt_events(
                        client_event_id, operator_user_id, captured_at,
                        server_received_at, device_id, event_type, input_method,
                        barcode_candidate,
                        tracking_no, tracking_no_normalized, duplicate_of_receipt_id,
                        evidence_status,
                        photo_storage_path, photo_original_name, photo_content_type,
                        photo_sha256, photo_size, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'RECEIVE', ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        client_event_id,
                        user.id,
                        db_timestamp(captured),
                        timestamp,
                        device_id,
                        input_method,
                        barcode_candidate,
                        tracking_no,
                        normalized_tracking,
                        duplicate_of_id,
                        relative_path,
                        photo.filename,
                        content_type,
                        photo_sha256,
                        photo_size,
                        timestamp,
                        timestamp,
                    ),
                )
                receipt_id = cursor.lastrowid
                connection.commit()
                row = _fetch_receipt(connection, receipt_id=receipt_id)
                receipt_out = _receipt_from_row(connection, row)
        except BaseException:
            temporary_path.unlink(missing_ok=True)
            if moved:
                destination_path.unlink(missing_ok=True)
            raise

        return ReceiptCreateResponse(
            created=True,
            idempotent_replay=False,
            receipt=receipt_out,
        )

    @application.get("/api/receipts", response_model=ReceiptListResponse)
    def list_receipts(
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
        limit: Annotated[int, Query(ge=1, le=100)] = 30,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> ReceiptListResponse:
        del user
        with _database(request).connect() as connection:
            total = connection.execute(
                "SELECT COUNT(*) AS count FROM receipt_events"
            ).fetchone()["count"]
            rows = connection.execute(
                RECEIPT_SELECT
                + " ORDER BY r.server_received_at DESC, r.id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            items = [_receipt_from_row(connection, row) for row in rows]
        return ReceiptListResponse(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
        )

    @application.patch("/api/receipts/{receipt_id}/tracking", response_model=ReceiptOut)
    def update_tracking_no(
        receipt_id: int,
        payload: TrackingUpdate,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> ReceiptOut:
        tracking_no = payload.tracking_no.strip()
        normalized = normalize_tracking_no(tracking_no)
        if not normalized:
            raise HTTPException(status_code=422, detail="tracking_no has no letters or digits")
        expected_tracking_no = payload.expected_tracking_no
        client_event_id = _validate_form_text(
            "client_event_id",
            payload.client_event_id,
            minimum=8,
            maximum=128,
        )
        with _database(request).connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            replay = connection.execute(
                """
                SELECT id, receipt_id, previous_tracking_no, new_tracking_no
                FROM receipt_change_events WHERE client_event_id = ?
                """,
                (client_event_id,),
            ).fetchone()
            if replay is not None:
                if (
                    replay["receipt_id"] != receipt_id
                    or replay["previous_tracking_no"] != expected_tracking_no
                    or replay["new_tracking_no"] != tracking_no
                ):
                    connection.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="client_event_id was already used for another change",
                    )
                row = _fetch_receipt(connection, receipt_id=receipt_id)
                if row is None:
                    connection.rollback()
                    raise HTTPException(status_code=404, detail="receipt not found")
                if row["tracking_no"] != replay["new_tracking_no"]:
                    connection.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail="tracking number changed after the original request; refresh before retrying",
                    )
                connection.rollback()
                return _receipt_from_row(connection, row)
            previous = connection.execute(
                """
                SELECT tracking_no, tracking_no_normalized
                FROM receipt_events WHERE id = ?
                """,
                (receipt_id,),
            ).fetchone()
            if previous is None:
                connection.rollback()
                raise HTTPException(status_code=404, detail="receipt not found")
            if previous["tracking_no"] != expected_tracking_no:
                connection.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="tracking number changed; refresh before retrying",
                )
            changed_at = db_timestamp(utc_now())
            cursor = connection.execute(
                """
                UPDATE receipt_events
                SET tracking_no = ?, tracking_no_normalized = ?, updated_at = ?
                WHERE id = ? AND tracking_no IS ?
                """,
                (
                    tracking_no,
                    normalized,
                    changed_at,
                    receipt_id,
                    expected_tracking_no,
                ),
            )
            if cursor.rowcount == 0:
                connection.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="tracking number changed; refresh before retrying",
                )
            connection.execute(
                """
                INSERT INTO receipt_change_events(
                    client_event_id, receipt_id, actor_user_id, action,
                    previous_tracking_no, new_tracking_no, created_at
                ) VALUES (?, ?, ?, 'TRACKING_UPDATE', ?, ?, ?)
                """,
                (
                    client_event_id,
                    receipt_id,
                    user.id,
                    previous["tracking_no"],
                    tracking_no,
                    changed_at,
                ),
            )
            recompute_tracking_duplicates(
                connection, previous["tracking_no_normalized"]
            )
            recompute_tracking_duplicates(connection, normalized)
            connection.commit()
            row = _fetch_receipt(connection, receipt_id=receipt_id)
            receipt_out = _receipt_from_row(connection, row)
        return receipt_out

    @application.get("/api/receipts/{receipt_id}/photo")
    def get_receipt_photo(
        receipt_id: int,
        request: Request,
        user: Annotated[AuthenticatedUser, Depends(require_user)],
    ) -> FileResponse:
        del user
        with _database(request).connect() as connection:
            row = connection.execute(
                """
                SELECT photo_storage_path, photo_content_type, photo_original_name
                FROM receipt_events WHERE id = ?
                """,
                (receipt_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="receipt not found")

        media_root = _settings(request).media_dir.resolve()
        photo_path = (media_root / row["photo_storage_path"]).resolve()
        if not photo_path.is_relative_to(media_root) or not photo_path.is_file():
            raise HTTPException(status_code=404, detail="photo not found")
        return FileResponse(
            photo_path,
            media_type=row["photo_content_type"],
            filename=row["photo_original_name"] or photo_path.name,
            content_disposition_type="inline",
        )

    @application.post(
        "/api/sync/v1/batches", response_model=SyncBatchResponse
    )
    async def sync_batches(
        request: Request,
        worker: Annotated[
            AuthenticatedSyncWorker, Depends(require_sync_worker)
        ],
    ) -> SyncBatchResponse:
        settings = _settings(request)
        database = _database(request)
        token_digest = worker.token_digest

        raw_body = await request.body()
        if len(raw_body) > settings.sync_max_batch_bytes:
            raise HTTPException(status_code=413, detail="batch exceeds size limit")
        try:
            parsed = json.loads(raw_body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=422, detail="batch must be valid JSON") from exc
        try:
            payload = SyncBatchIn.model_validate(parsed)
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail=exc.errors(include_url=False, include_context=False, include_input=False),
            ) from exc

        idempotency_key = request.headers.get("idempotency-key", "").strip()
        if idempotency_key != payload.batch_id:
            raise HTTPException(
                status_code=422,
                detail="Idempotency-Key header must match the batch_id in the body",
            )
        if len(payload.orders) > settings.sync_max_batch_orders:
            raise HTTPException(
                status_code=422,
                detail=f"batch exceeds the configured order limit of {settings.sync_max_batch_orders}",
            )
        seen_order_ids: set[str] = set()
        for order in payload.orders:
            order_id = order.platform_order_id.strip()
            if order_id in seen_order_ids:
                raise HTTPException(
                    status_code=422,
                    detail=f"duplicate platform_order_id in batch: {order_id}",
                )
            seen_order_ids.add(order_id)

        payload_sha256 = canonical_payload_digest(
            json.dumps(parsed, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode(
                "utf-8"
            )
        )
        with database.connect() as connection:
            existing = connection.execute(
                """
                SELECT payload_sha256, status, counts_json, cursor_after
                FROM sync_batches WHERE batch_id = ?
                """,
                (payload.batch_id,),
            ).fetchone()
        if existing is not None:
            if existing["payload_sha256"] != payload_sha256:
                raise HTTPException(
                    status_code=409,
                    detail="batch_id was already used with different content",
                )
            if existing["status"] == "OK":
                counts = parse_batch_counts(existing["counts_json"])
                return SyncBatchResponse(
                    batch_id=payload.batch_id,
                    created=counts.get("created", 0),
                    updated=counts.get("updated", 0),
                    skipped=counts.get("skipped", 0),
                    errors=[],
                    cursor_accepted=True,
                )
            with database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "DELETE FROM sync_batches WHERE batch_id = ? AND status = 'ERROR'",
                    (payload.batch_id,),
                )
                connection.commit()

        now = utc_now()
        cutoff = db_timestamp(now - timedelta(hours=1))
        with database.connect() as connection:
            rate_row = connection.execute(
                """
                SELECT COUNT(*) AS count, MIN(received_at) AS oldest
                FROM sync_batches
                WHERE token_digest = ? AND received_at >= ?
                """,
                (token_digest, cutoff),
            ).fetchone()
        if rate_row["count"] >= settings.sync_rate_limit_per_hour:
            retry_after = 3600
            if rate_row["oldest"] is not None:
                oldest = datetime.fromisoformat(
                    rate_row["oldest"].replace("Z", "+00:00")
                )
                retry_after = max(60, int((oldest + timedelta(hours=1) - now).total_seconds()))
            raise HTTPException(
                status_code=429,
                detail="sync rate limit exceeded",
                headers={"Retry-After": str(retry_after)},
            )

        try:
            with database.connect() as connection:
                counts = ingest_sync_batch(
                    connection,
                    payload,
                    payload_sha256,
                    token_digest,
                    db_timestamp(now),
                )
        except BaseException:
            raise HTTPException(
                status_code=500, detail="batch ingest failed"
            )
        return SyncBatchResponse(
            batch_id=payload.batch_id,
            created=counts["created"],
            updated=counts["updated"],
            skipped=counts["skipped"],
            errors=[],
            cursor_accepted=True,
        )

    return application


app = create_app()
