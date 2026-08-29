from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: Literal["ADMIN", "RECEIVER"]


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
