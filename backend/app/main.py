from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import sqlite3
import tempfile
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any

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

from .config import Settings
from .database import Database
from .schemas import (
    AuthResponse,
    LoginRequest,
    ReceiptCreateResponse,
    ReceiptListResponse,
    ReceiptOut,
    TrackingUpdate,
    UserOut,
)
from .security import (
    new_session_token,
    session_token_digest,
    verify_password,
)


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

    def public(self) -> UserOut:
        return UserOut(
            id=self.id,
            username=self.username,
            display_name=self.display_name,
            role=self.role,
        )


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _database(request: Request) -> Database:
    return request.app.state.database


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
                SELECT id, username, display_name, role, is_active
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
                u.id, u.username, u.display_name, u.role, u.is_active
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
    )


RECEIPT_SELECT = """
SELECT
    r.*,
    u.username AS operator_username,
    u.display_name AS operator_display_name,
    u.role AS operator_role,
    duplicate.server_received_at AS duplicate_server_received_at
FROM receipt_events r
JOIN users u ON u.id = r.operator_user_id
LEFT JOIN receipt_events duplicate ON duplicate.id = r.duplicate_of_receipt_id
"""


def _receipt_from_row(row: sqlite3.Row) -> ReceiptOut:
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
        ),
        photo={
            "content_type": row["photo_content_type"],
            "size": row["photo_size"],
            "sha256": row["photo_sha256"],
            "url": photo_url,
        },
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
        settings.media_dir.mkdir(parents=True, exist_ok=True)
        (settings.media_dir / ".tmp").mkdir(parents=True, exist_ok=True)
        database = Database(settings.database_path)
        database.initialize(
            bootstrap_username=settings.bootstrap_admin_username,
            bootstrap_password=settings.bootstrap_admin_password,
            bootstrap_display_name=settings.bootstrap_admin_display_name,
            now=db_timestamp(utc_now()),
        )
        application.state.settings = settings
        application.state.database = database
        yield

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

    @application.post("/api/auth/login", response_model=AuthResponse)
    def login(payload: LoginRequest, request: Request, response: Response) -> AuthResponse:
        settings = _settings(request)
        database = _database(request)
        username = payload.username.strip()
        with database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, username, display_name, role, password_hash, is_active
                FROM users WHERE username = ?
                """,
                (username,),
            ).fetchone()
            if (
                row is None
                or not row["is_active"]
                or not verify_password(payload.password, row["password_hash"])
            ):
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
        if input_method != "PHOTO_CAPTURE":
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
            return ReceiptCreateResponse(
                created=False,
                idempotent_replay=True,
                receipt=_receipt_from_row(existing),
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
            with database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                existing = _fetch_receipt(connection, client_event_id=client_event_id)
                if existing is not None:
                    connection.rollback()
                    temporary_path.unlink(missing_ok=True)
                    response.status_code = 200
                    return ReceiptCreateResponse(
                        created=False,
                        idempotent_replay=True,
                        receipt=_receipt_from_row(existing),
                    )

                os.replace(temporary_path, destination_path)
                moved = True
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
                        server_received_at, device_id, barcode_candidate,
                        tracking_no, tracking_no_normalized, duplicate_of_receipt_id,
                        evidence_status,
                        photo_storage_path, photo_original_name, photo_content_type,
                        photo_sha256, photo_size, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        client_event_id,
                        user.id,
                        db_timestamp(captured),
                        timestamp,
                        device_id,
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
        except BaseException:
            temporary_path.unlink(missing_ok=True)
            if moved:
                destination_path.unlink(missing_ok=True)
            raise

        return ReceiptCreateResponse(
            created=True,
            idempotent_replay=False,
            receipt=_receipt_from_row(row),
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
        return ReceiptListResponse(
            items=[_receipt_from_row(row) for row in rows],
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
        del user
        tracking_no = payload.tracking_no.strip()
        normalized = normalize_tracking_no(tracking_no)
        if not normalized:
            raise HTTPException(status_code=422, detail="tracking_no has no letters or digits")
        with _database(request).connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            previous = connection.execute(
                "SELECT tracking_no_normalized FROM receipt_events WHERE id = ?",
                (receipt_id,),
            ).fetchone()
            if previous is None:
                raise HTTPException(status_code=404, detail="receipt not found")
            cursor = connection.execute(
                """
                UPDATE receipt_events
                SET tracking_no = ?, tracking_no_normalized = ?, updated_at = ?
                WHERE id = ?
                """,
                (tracking_no, normalized, db_timestamp(utc_now()), receipt_id),
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="receipt not found")
            recompute_tracking_duplicates(
                connection, previous["tracking_no_normalized"]
            )
            recompute_tracking_duplicates(connection, normalized)
            connection.commit()
            row = _fetch_receipt(connection, receipt_id=receipt_id)
        return _receipt_from_row(row)

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

    return application


app = create_app()
