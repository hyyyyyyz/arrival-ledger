from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


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
    platform: Literal["pdd", "1688"]
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
    platform: Literal["pdd", "1688"]
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


class PurchaseOrderListResponse(BaseModel):
    items: list[PurchaseOrderOut]
    total: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    last_synced_at: datetime | None = Field(
        default=None,
        description="Oldest latest-success timestamp across accounts represented by this order view; null when any account has never synced successfully",
    )


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
