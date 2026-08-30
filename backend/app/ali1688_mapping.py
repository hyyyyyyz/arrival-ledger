"""Allowlisted conversion of 1688 responses into the existing sync contract."""
from __future__ import annotations

from datetime import datetime, timezone
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from .sync_ingest import SyncOrderIn, SyncOrderItemIn, SyncPackageIn

STATUS_MAP = {
    "waitbuyerpay": "PENDING", "waitbuyerreceive": "SHIPPED", "waitsellersend": "PAID",
    "waitlogisticstakein": "PAID", "waitbuyersign": "SHIPPED",
    "signinsuccess": "COMPLETED", "terminated": "CANCELLED",
    "success": "COMPLETED", "cancel": "CANCELLED", "closed": "CANCELLED",
    "refundsuccess": "REFUNDED", "refunded": "REFUNDED",
}

PACKAGE_STATUS_MAP = {
    "alreadysend": "SHIPPED",
    "waitsend": "PAID",
    "waitlogistics": "PAID",
    "transport": "IN_TRANSIT",
    "intransit": "IN_TRANSIT",
    "delivered": "DELIVERED",
    "received": "DELIVERED",
    "signinsuccess": "DELIVERED",
}


def normalized_status(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text or text not in STATUS_MAP:
        raise ValueError("1688 order has an unknown status")
    return STATUS_MAP[text]


def normalized_package_status(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip().lower()
    if text not in PACKAGE_STATUS_MAP:
        raise ValueError("1688 logistics item has an unknown status")
    return PACKAGE_STATUS_MAP[text]


def _first(obj: dict[str, Any], *keys: str) -> Any:
    return next((obj[k] for k in keys if k in obj and obj[k] not in (None, "")), None)


def _price(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return format(Decimal(str(value)), "f")
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("1688 item has an invalid price") from exc


def _date(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000 if value > 10_000_000_000 else value, tz=timezone.utc)
    text = str(value).strip()
    try:
        # Alibaba's java.util.Date wire representation is exactly
        # yyyyMMddHHmmssSSS+0800 (or another +/-HHMM offset).  It cannot be
        # parsed by datetime.fromisoformat without losing the millisecond
        # boundary, so parse it explicitly first.
        match = re.fullmatch(r"(\d{17})([+-]\d{4})", text)
        if match:
            return datetime.strptime(
                match.group(1) + match.group(2), "%Y%m%d%H%M%S%f%z"
            )
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError("1688 order has an invalid date") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("1688 order date is missing a timezone offset")
    return parsed


def _sku_text(value: Any) -> str | None:
    """Render official skuInfos into a deterministic, non-PII string."""
    if value in (None, ""):
        return None
    entries: list[str] = []
    values = value if isinstance(value, list) else [value]
    for entry in values:
        if isinstance(entry, dict):
            name = _first(entry, "name", "attributeName", "attributeDisplayName")
            selected = _first(entry, "value", "attributeValue", "text")
            if selected is None:
                continue
            entries.append(f"{name}: {selected}" if name else str(selected))
        elif isinstance(entry, (str, int, float)):
            entries.append(str(entry))
    rendered = " / ".join(entries).strip()
    return rendered[:200] if rendered else None


def _tracking(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if text.lower() in {"不需要物流", "无需物流", "no logistics", "none", "null", "-"}:
        return None
    return text if re.search(r"[A-Za-z0-9]", text) else None


def map_order(raw: dict[str, Any], detail: dict[str, Any] | None = None) -> SyncOrderIn:
    if not isinstance(raw, dict):
        raise ValueError("order must be an object")
    base = raw.get("baseInfo") if isinstance(raw.get("baseInfo"), dict) else raw
    oid = _first(base, "idOfStr", "orderIdOfStr")
    if not isinstance(oid, str) or not oid.strip():
        raise ValueError("order is missing idOfStr")
    items_raw = raw.get("productItems") or (detail or {}).get("productItems")
    if not isinstance(items_raw, list) or not items_raw:
        raise ValueError("1688 order has no productItems")
    items: list[SyncOrderItemIn] = []
    for item in items_raw:
        if not isinstance(item, dict):
            raise ValueError("1688 productItems contains a non-object entry")
        # subItemIDString identifies the line item/SKU.  Falling back to the
        # product ID alone would collapse two SKUs of the same product.
        key = _first(item, "subItemIDString", "subItemID", "skuID", "skuId", "productID", "productId", "itemId", "id")
        if key is None:
            raise ValueError("1688 item has no stable SKU or line identifier")
        title = _first(item, "name", "title", "productName", "subject")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("1688 item has no title")
        sku = _sku_text(_first(item, "skuInfos", "skuInfo")) or _first(item, "skuText", "specInfo", "sku", "specification")
        quantity_raw = _first(item, "quantity", "amount", "productAmount")
        try:
            quantity_decimal = Decimal(str(quantity_raw))
            if quantity_decimal != quantity_decimal.to_integral_value() or quantity_decimal < 1:
                raise ValueError
            quantity = int(quantity_decimal)
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise ValueError("1688 item has an invalid quantity") from exc
        items.append(SyncOrderItemIn(
            item_key=str(key),
            title=title[:300],
            sku_text=str(sku)[:200] if sku is not None else None,
            quantity=quantity,
            unit_price=_price(_first(item, "price", "unitPrice", "priceWithTax", "amount")),
        ))
    status = normalized_status(_first(base, "status", "orderStatus"))
    logistics = (detail or {}).get("nativeLogistics") or raw.get("nativeLogistics")
    if logistics is not None and not isinstance(logistics, dict):
        raise ValueError("1688 nativeLogistics must be an object")
    packages_raw = logistics.get("logisticsItems", []) if logistics is not None else []
    if not isinstance(packages_raw, list):
        raise ValueError("1688 logisticsItems must be an array")
    packages: list[SyncPackageIn] = []
    explicit_no_logistics = False
    for package in packages_raw:
        if not isinstance(package, dict):
            raise ValueError("1688 logisticsItems contains a non-object entry")
        bill_value = _first(package, "logisticsBillNo", "trackingNo", "mailNo")
        tracking = _tracking(bill_value)
        # Some official responses use logisticsCode when bill number is
        # absent or contain the sentinel "不需要物流" in logisticsBillNo.
        if tracking is None:
            tracking = _tracking(_first(package, "logisticsCode", "logistics_code"))
        if tracking is None:
            bill_text = str(bill_value or "").strip().lower()
            this_item_has_no_logistics = bool(
                package.get("noLogisticsBillNo")
                or package.get("noLogisticsName")
                or bill_text in {"不需要物流", "无需物流", "no logistics", "none", "null", "-"}
            )
            explicit_no_logistics = explicit_no_logistics or this_item_has_no_logistics
            if this_item_has_no_logistics:
                continue
            # 1688 may retain a historical logistics row after an order is
            # cancelled/refunded even though that row has no bill number.
            # Closed orders never require warehouse receipt matching, so the
            # unusable row is safe to ignore. Active orders still fail closed.
            if status in {"CANCELLED", "REFUNDED"}:
                continue
            raise ValueError("1688 logistics item has no usable tracking number")
        courier_value = _first(
            package,
            "logisticsCompanyName",
            "logisticsCompany",
            "companyName",
            "company",
            "logisticsCompanyNo",
        )
        packages.append(SyncPackageIn(
            courier=str(courier_value)[:64] if courier_value is not None else None,
            tracking_no=tracking,
            status=normalized_package_status(_first(package, "status", "logisticsStatus")),
        ))
    if status == "SHIPPED" and not packages and not explicit_no_logistics:
        raise ValueError("shipped 1688 order has no logistics item")
    ordered_at_raw = _first(base, "createTime", "createdTime", "orderCreateTime")
    if ordered_at_raw is None:
        raise ValueError("1688 order has no create time")
    shop = _first(base, "sellerLoginId", "sellerName", "shopName")
    return SyncOrderIn(
        platform_order_id=str(oid),
        ordered_at=_date(ordered_at_raw),
        status=status,
        shop_name=str(shop)[:128] if shop is not None else None,
        items=items,
        packages=packages,
        observed_at=datetime.now(timezone.utc),
    )


def list_orders(payload: Any) -> list[dict[str, Any]]:
    """Extract only order objects from known list response shapes."""
    values: Any = None
    if isinstance(payload, dict) and isinstance(payload.get("result"), list):
        values = payload["result"]
    if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
        result = payload["result"]
        for key in ("orders", "orderList", "result"):
            if isinstance(result.get(key), list):
                values = result[key]
                break
    if values is None:
        return []
    if any(not isinstance(value, dict) for value in values):
        raise ValueError("1688 order list contains a non-object entry")
    return values


# Stable descriptive aliases used by callers and integration tests.
map_official_order = map_order
map_status = normalized_status
