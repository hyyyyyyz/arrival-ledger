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
    platform: Literal["pdd", "1688"]
    platform_order_id: str
    shop_name: str | None
    courier: str | None
    tracking_no: str
    items: list[OrderMatchItemOut]
    confidence: Literal["EXACT", "CANDIDATE"]


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
