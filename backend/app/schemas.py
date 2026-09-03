from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _validate_bcrypt_password_bytes(value: str) -> str:
    if len(value.encode("utf-8")) > 72:
        raise ValueError("password must not exceed 72 UTF-8 bytes")
    return value


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)

    _password_fits_bcrypt = field_validator("password")(
        _validate_bcrypt_password_bytes
    )


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)

    _password_fits_bcrypt = field_validator("current_password", "new_password")(
        _validate_bcrypt_password_bytes
    )


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: Literal["ADMIN", "RECEIVER"]
    is_active: bool = True
    last_login_at: datetime | None = None


class UserListResponse(BaseModel):
    items: list[UserOut]
    total: int = Field(ge=0)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    display_name: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=12, max_length=256)
    role: Literal["ADMIN", "RECEIVER"] = "RECEIVER"

    _password_fits_bcrypt = field_validator("password")(
        _validate_bcrypt_password_bytes
    )


class UserActivationUpdate(BaseModel):
    is_active: bool


class UserManagementAuditEventOut(BaseModel):
    id: int
    actor_user_id: int
    actor_username: str
    actor_display_name: str
    target_user_id: int
    target_username: str
    target_display_name: str
    target_role: Literal["ADMIN", "RECEIVER"]
    action: Literal["CREATE", "ACTIVATE", "DEACTIVATE"]
    created_at: datetime


class UserManagementAuditListResponse(BaseModel):
    items: list[UserManagementAuditEventOut]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)


class AuthResponse(BaseModel):
    user: UserOut
    auth_required: bool = True


PlatformAccountSyncStatus = Literal[
    "OK",
    "NEEDS_LOGIN",
    "CAPTCHA_OR_BLOCKED",
    "SCHEMA_CHANGED",
    "NETWORK_ERROR",
    "DISABLED",
]


def normalize_platform_account_key(value: str) -> str:
    normalized = value.strip().lower()
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", normalized) is None:
        raise ValueError(
            "account_key must start with a letter or digit and contain only "
            "lowercase letters, digits, ., _ and -"
        )
    return normalized


class PlatformAccountCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    platform: Literal["pdd"]
    account_key: str = Field(min_length=1, max_length=64)
    display_label: str = Field(min_length=1, max_length=128)

    @field_validator("account_key")
    @classmethod
    def normalize_account_key(cls, value: str) -> str:
        return normalize_platform_account_key(value)

    @field_validator("display_label")
    @classmethod
    def display_label_not_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("display_label must not be blank")
        return normalized


class PlatformAccountStatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    worker_id: str = Field(min_length=1, max_length=64)
    platform: Literal["pdd"]
    platform_account_key: str = Field(min_length=1, max_length=64)
    platform_account_label: str | None = Field(default=None, max_length=128)
    status: PlatformAccountSyncStatus
    checked_at: datetime
    count: int | None = Field(default=None, ge=0)
    message: str | None = Field(default=None, max_length=256)

    @field_validator("worker_id")
    @classmethod
    def worker_id_not_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("worker_id must not be blank")
        return normalized

    @field_validator("platform_account_key")
    @classmethod
    def normalize_account_key(cls, value: str) -> str:
        return normalize_platform_account_key(value)

    @field_validator("platform_account_label")
    @classmethod
    def optional_label_not_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("platform_account_label must not be blank")
        return normalized

    @field_validator("checked_at")
    @classmethod
    def checked_at_is_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("checked_at must include a timezone offset")
        return value

    @field_validator("message")
    @classmethod
    def normalize_message(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class PlatformAccountOut(BaseModel):
    id: int
    platform: Literal["pdd", "1688"]
    account_key: str
    display_label: str | None
    source: Literal["WINDOWS_BROWSER", "ALI1688_API"]
    status: PlatformAccountSyncStatus
    worker_id: str | None
    order_count: int = Field(ge=0)
    last_attempt_at: datetime | None
    last_success_at: datetime | None
    last_count: int = Field(ge=0)
    message: str | None
    created_at: datetime
    updated_at: datetime
    status_updated_at: datetime


class PlatformAccountListResponse(BaseModel):
    items: list[PlatformAccountOut]
    total: int = Field(ge=0)


class DashboardStatsOut(BaseModel):
    total_orders: int = Field(ge=0, description="Imported purchase order count")
    arrival_photos: int = Field(
        ge=0, description="Canonical READY receipt photo count"
    )
    matched_orders: int = Field(
        ge=0,
        description="Distinct orders confirmed by a canonical READY photo whose tracking number links to one order",
    )
    received_orders: int = Field(
        ge=0,
        description="Orders whose every known package has a confirmed one-order READY receipt",
    )
    review_orders: int = Field(
        ge=0,
        description="Orders that are partially received or have candidate receipt matches",
    )
    linked_orders: int = Field(
        ge=0,
        description="Distinct orders linked to canonical READY receipts, including candidates",
    )
    candidate_photos: int = Field(
        ge=0,
        description="Canonical READY photos whose tracking number links to multiple orders",
    )
    unlinked_orders: int = Field(
        ge=0, description="Orders without a confirmed one-order tracking match"
    )
    pending_orders: int = Field(
        ge=0,
        description="Active orders with neither confirmed nor candidate receipt evidence",
    )
    unmatched_photos: int = Field(
        ge=0, description="Canonical READY photos with no linked purchase order"
    )
    account_count: int = Field(ge=0, description="Imported platform account count")


class PhotoOut(BaseModel):
    content_type: str
    size: int
    sha256: str
    url: str


class DuplicateOfOut(BaseModel):
    id: int
    server_received_at: datetime
    photo_url: str


class OrderMatchItemOut(BaseModel):
    title: str
    sku_text: str | None
    quantity: str


class OrderMatchOut(BaseModel):
    order_id: str = Field(description="Stable internal purchase order identity")
    platform: Literal["pdd", "1688", "other"]
    platform_order_id: str
    account_label: str | None = Field(
        default=None, description="Optional non-secret platform account display label"
    )
    shop_name: str | None
    courier: str | None
    tracking_no: str
    items: list[OrderMatchItemOut]
    confidence: Literal["EXACT", "CANDIDATE"]


class PurchaseOrderItemOut(BaseModel):
    title: str
    sku_text: str | None
    quantity: str
    unit_price: str | None


class PurchaseOrderPackageOut(BaseModel):
    courier: str | None
    tracking_no: str
    package_status: str | None
    arrival_status: Literal["PENDING", "ARRIVED", "CANDIDATE"]
    arrived: bool


class OrderArrivalStatusUpdate(BaseModel):
    status: Literal["PENDING", "RECEIVED"]
    expected_revision: int = Field(ge=0)
    client_event_id: str = Field(min_length=8, max_length=128)
    reason: str | None = Field(default=None, max_length=256)


class OrderArrivalStateOut(BaseModel):
    order_id: str
    effective_arrival_status: Literal["PENDING", "REVIEW", "RECEIVED", "CLOSED"]
    evidence_arrival_status: Literal["PENDING", "REVIEW", "RECEIVED"]
    arrival_source: Literal["AUTO", "MANUAL"]
    responsible_user: UserOut | None
    manual_revision: int = Field(ge=0)
    changed_at: datetime | None
    audit_event_id: int | None = None
    idempotent_replay: bool = False


class OrderArrivalAuditEventOut(BaseModel):
    id: int
    client_event_id: str
    order_id: str
    actor: UserOut
    action: Literal["MARK_RECEIVED", "MARK_PENDING"]
    previous_effective_status: Literal["PENDING", "REVIEW", "RECEIVED"]
    new_effective_status: Literal["PENDING", "RECEIVED"]
    previous_override_status: Literal["PENDING", "RECEIVED"] | None
    new_override_status: Literal["PENDING", "RECEIVED"]
    previous_revision: int = Field(ge=0)
    new_revision: int = Field(ge=1)
    reason: str | None
    created_at: datetime


class OrderArrivalAuditListResponse(BaseModel):
    items: list[OrderArrivalAuditEventOut]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)


class PurchaseOrderOut(BaseModel):
    id: str = Field(description="Stable internal purchase order identity")
    platform: Literal["pdd", "1688", "other"]
    account_label: str
    platform_order_id: str
    ordered_at: datetime | None
    order_status: str
    shop_name: str | None
    source: str
    items: list[PurchaseOrderItemOut]
    packages: list[PurchaseOrderPackageOut]
    package_count: int = Field(ge=0)
    arrived_package_count: int = Field(ge=0)
    candidate_package_count: int = Field(ge=0)
    arrival_photo_count: int = Field(
        ge=0,
        description="Canonical READY photos whose tracking number uniquely links to this order",
    )
    candidate_photo_count: int = Field(
        ge=0,
        description="Canonical READY photos whose tracking number links to multiple orders",
    )
    effective_arrival_status: Literal["PENDING", "REVIEW", "RECEIVED", "CLOSED"]
    evidence_arrival_status: Literal["PENDING", "REVIEW", "RECEIVED"]
    arrival_source: Literal["AUTO", "MANUAL"]
    responsible_user: UserOut | None
    manual_revision: int = Field(ge=0)
    changed_at: datetime | None
    manual_created_by: UserOut | None = None
    manual_created_at: datetime | None = None
    manual_remark: str | None = None


class OrderAccountOptionOut(BaseModel):
    id: int
    platform: Literal["pdd", "1688", "other"]
    account_label: str


class PurchaseOrderListResponse(BaseModel):
    items: list[PurchaseOrderOut]
    account_options: list[OrderAccountOptionOut] = Field(default_factory=list)
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    last_synced_at: datetime | None = Field(
        default=None,
        description="Oldest latest-success timestamp across accounts represented by this order view; null when any account has never synced successfully",
    )


class ManualOrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_event_id: str = Field(min_length=8, max_length=128)
    tracking_no: str = Field(min_length=1, max_length=128)
    product_name: str = Field(min_length=1, max_length=256)
    courier: str | None = Field(default=None, max_length=128)
    remark: str | None = Field(default=None, max_length=512)

    @field_validator("client_event_id", "tracking_no", "product_name")
    @classmethod
    def required_text_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value

    @field_validator("courier", "remark")
    @classmethod
    def optional_text_normalized(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ManualOrderCreateResponse(BaseModel):
    created: bool
    idempotent_replay: bool
    order_id: str
    platform_order_id: str
    tracking_no: str
    product_name: str
    courier: str | None
    source: Literal["THIRD_PARTY_MANUAL"]


class ManualOrderBatchRow(BaseModel):
    """One frontend-parsed spreadsheet row.

    Cell values intentionally remain untyped here so a malformed row can be
    reported alongside successful rows instead of rejecting the whole batch.
    The endpoint performs strict per-row validation before any write.
    """

    model_config = ConfigDict(extra="forbid")

    row_number: int | None = Field(default=None, ge=1, le=1_000_000)
    tracking_no: Any = Field(
        default=None,
        description="运单号必须由 Excel 解析器保留为 JSON string",
        json_schema_extra={"type": "string"},
    )
    product_name: Any = None
    courier: Any = None
    remark: Any = None


class ManualOrderBatchCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_batch_id: str = Field(min_length=8, max_length=128)
    tracking_text: str | None = Field(default=None, max_length=524_288)
    product_name: str | None = Field(default=None, max_length=256)
    courier: str | None = Field(default=None, max_length=128)
    remark: str | None = Field(default=None, max_length=512)
    rows: list[ManualOrderBatchRow] = Field(default_factory=list, max_length=500)

    @field_validator("client_batch_id")
    @classmethod
    def batch_id_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value

    @field_validator("tracking_text", "product_name", "courier", "remark")
    @classmethod
    def optional_batch_text_normalized(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def at_least_one_input_source(self) -> "ManualOrderBatchCreate":
        if self.tracking_text is None and not self.rows:
            raise ValueError("tracking_text or rows is required")
        return self


ManualOrderBatchItemStatus = Literal[
    "CREATED",
    "IDEMPOTENT",
    "DUPLICATE_INPUT",
    "FAILED",
]

ManualOrderBatchErrorCode = Literal[
    "MISSING_TRACKING",
    "INVALID_TRACKING",
    "TRACKING_TOO_LONG",
    "INVALID_FIELD_TYPE",
    "PRODUCT_NAME_TOO_LONG",
    "COURIER_TOO_LONG",
    "REMARK_TOO_LONG",
    "PLATFORM_ORDER_EXISTS",
    "MANUAL_ORDER_EXISTS",
    "EVENT_CONFLICT",
    "DATABASE_CONFLICT",
]


class ManualOrderBatchItemResult(BaseModel):
    input_index: int = Field(ge=1, le=500)
    row_number: int | None = Field(default=None, ge=1, le=1_000_000)
    tracking_no: str | None = None
    tracking_no_normalized: str | None = None
    status: ManualOrderBatchItemStatus
    created: bool = False
    idempotent_replay: bool = False
    order_id: str | None = None
    platform_order_id: str | None = None
    product_name: str | None = None
    courier: str | None = None
    error_code: ManualOrderBatchErrorCode | None = None
    message: str | None = None


class ManualOrderBatchCreateResponse(BaseModel):
    client_batch_id: str
    idempotent_replay: bool
    total_count: int = Field(ge=1, le=500)
    unique_count: int = Field(ge=0, le=500)
    created_count: int = Field(ge=0, le=500)
    idempotent_count: int = Field(ge=0, le=500)
    duplicate_count: int = Field(ge=0, le=500)
    failed_count: int = Field(ge=0, le=500)
    items: list[ManualOrderBatchItemResult] = Field(max_length=500)


class ReceiptOut(BaseModel):
    id: int
    client_event_id: str
    captured_at: datetime
    occurred_at: datetime
    server_received_at: datetime
    device_id: str
    barcode_candidate: str | None
    tracking_no: str | None
    evidence_status: Literal["PENDING", "READY", "FAILED"]
    photo_url: str
    is_duplicate: bool = False
    duplicate_of_id: int | None = None
    duplicate_of: DuplicateOfOut | None = None
    operator: UserOut
    last_modified_by: UserOut | None = None
    last_modified_at: datetime | None = None
    photo: PhotoOut
    order_matches: list[OrderMatchOut] = []


class ReceiptCreateResponse(BaseModel):
    created: bool
    idempotent_replay: bool
    receipt: ReceiptOut


class ReceiptListResponse(BaseModel):
    items: list[ReceiptOut]
    total: int
    limit: int
    offset: int


class TrackingUpdate(BaseModel):
    tracking_no: str = Field(min_length=1, max_length=128)
    expected_tracking_no: str | None = Field(max_length=128)
    client_event_id: str = Field(min_length=8, max_length=128)
