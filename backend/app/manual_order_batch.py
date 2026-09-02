from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import HTTPException, Request, status
from pydantic import ValidationError

from .schemas import ManualOrderBatchCreate


MAX_MANUAL_BATCH_BODY_BYTES = 512 * 1024
MAX_MANUAL_BATCH_ITEMS = 500
DEFAULT_MANUAL_PRODUCT_NAME = "未填写商品名称"

_TRACKING_SPLIT = re.compile(r"[,，;；\r\n]+")
_SCIENTIFIC_NOTATION = re.compile(
    r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$"
)
_DECIMAL_NUMERIC = re.compile(r"^[+-]?\d+[.,]\d+$")
_DATE_LIKE_YMD = re.compile(r"^\d{4}([./-])\d{1,2}\1\d{1,2}(?:[ T].*)?$")
_DATE_LIKE_DMY = re.compile(r"^\d{1,2}([./-])\d{1,2}\1\d{4}(?:[ T].*)?$")
_DATE_LIKE_CN = re.compile(r"^\d{4}年\d{1,2}月\d{1,2}[日号](?:.*)?$")
_MANUAL_TRACKING_ALLOWED = re.compile(r"^[A-Za-z0-9 -]+$")
_TRUNCATED_DECIMAL_IN_TRACKING_TEXT = re.compile(
    r"(?:^|[,，;；\r\n])\s*[+-]?\d{8,32}\s*[,，]\s*\d{1,7}\s*(?=$|[,，;；\r\n])"
)

BatchValidationCode = Literal[
    "MISSING_TRACKING",
    "INVALID_TRACKING",
    "TRACKING_TOO_LONG",
    "INVALID_FIELD_TYPE",
    "PRODUCT_NAME_TOO_LONG",
    "COURIER_TOO_LONG",
    "REMARK_TOO_LONG",
]


@dataclass(frozen=True)
class ManualBatchInput:
    input_index: int
    row_number: int | None
    tracking_no: Any
    product_name: Any
    courier: Any
    remark: Any


@dataclass(frozen=True)
class ValidatedManualBatchInput:
    input_index: int
    row_number: int | None
    tracking_no: str
    tracking_no_normalized: str
    product_name: str
    courier: str | None
    remark: str | None


@dataclass(frozen=True)
class ManualBatchValidationFailure:
    input_index: int
    row_number: int | None
    tracking_no: str | None
    tracking_no_normalized: str | None
    error_code: BatchValidationCode
    message: str


def normalize_manual_tracking_no(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def looks_like_spreadsheet_coercion(value: str) -> bool:
    compact = re.sub(r"\s+", "", value)
    return bool(
        _SCIENTIFIC_NOTATION.fullmatch(compact)
        or _DECIMAL_NUMERIC.fullmatch(compact)
        or _DATE_LIKE_YMD.fullmatch(value)
        or _DATE_LIKE_YMD.fullmatch(compact)
        or _DATE_LIKE_DMY.fullmatch(value)
        or _DATE_LIKE_DMY.fullmatch(compact)
        or _DATE_LIKE_CN.fullmatch(compact)
    )


def manual_tracking_format_error(value: str) -> str | None:
    if looks_like_spreadsheet_coercion(value):
        return "运单号疑似被 Excel 转换为科学计数法、数值或日期，请按文本格式重新录入"
    if _MANUAL_TRACKING_ALLOWED.fullmatch(value) is None:
        return "一个输入只能包含一个运单号，且只能使用英文字母、数字、空格或连字符；多单号请分行录入"
    return None


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


async def read_manual_batch_payload(request: Request) -> ManualOrderBatchCreate:
    """Read a bounded JSON body before Pydantic sees it.

    Using Request.stream() prevents a chunked request without Content-Length
    from making the application buffer an unbounded spreadsheet conversion.
    """

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json" and not content_type.endswith("+json"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Content-Type 必须是 application/json",
        )

    raw_content_length = request.headers.get("content-length")
    if raw_content_length is not None:
        try:
            content_length = int(raw_content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Content-Length 无效") from exc
        if content_length < 0:
            raise HTTPException(status_code=400, detail="Content-Length 无效")
        if content_length > MAX_MANUAL_BATCH_BODY_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="批量录入请求体不能超过 512 KiB",
            )

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_MANUAL_BATCH_BODY_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="批量录入请求体不能超过 512 KiB",
            )
    if not body:
        raise HTTPException(status_code=422, detail="请求体不能为空")

    try:
        raw_payload = json.loads(
            body.decode("utf-8"),
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="请求体必须是有效的 UTF-8 JSON") from exc

    try:
        return ManualOrderBatchCreate.model_validate(raw_payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=exc.errors(include_url=False, include_context=False),
        ) from exc


def expand_manual_batch_inputs(payload: ManualOrderBatchCreate) -> list[ManualBatchInput]:
    inputs: list[ManualBatchInput] = []
    if payload.tracking_text is not None:
        if _TRUNCATED_DECIMAL_IN_TRACKING_TEXT.search(payload.tracking_text):
            raise HTTPException(
                status_code=422,
                detail="粘贴内容疑似包含被 Excel 改写的小数单号，请将单号设为文本后重新粘贴",
            )
        for raw_tracking in _TRACKING_SPLIT.split(payload.tracking_text):
            tracking = raw_tracking.strip()
            if not tracking:
                continue
            inputs.append(
                ManualBatchInput(
                    input_index=len(inputs) + 1,
                    row_number=None,
                    tracking_no=tracking,
                    product_name=payload.product_name,
                    courier=payload.courier,
                    remark=payload.remark,
                )
            )

    for row in payload.rows:
        inputs.append(
            ManualBatchInput(
                input_index=len(inputs) + 1,
                row_number=row.row_number,
                tracking_no=row.tracking_no,
                product_name=row.product_name if row.product_name is not None else payload.product_name,
                courier=row.courier if row.courier is not None else payload.courier,
                remark=row.remark if row.remark is not None else payload.remark,
            )
        )

    if not inputs:
        raise HTTPException(status_code=422, detail="没有可导入的运单号")
    if len(inputs) > MAX_MANUAL_BATCH_ITEMS:
        raise HTTPException(
            status_code=422,
            detail=f"一次最多录入 {MAX_MANUAL_BATCH_ITEMS} 条运单",
        )
    return inputs


def _tracking_text_value(value: Any) -> tuple[str | None, ManualBatchValidationFailure | None]:
    # Spreadsheet parsers must preserve tracking cells as strings. Accepting
    # JSON numbers would silently lose leading zeroes and can lose precision
    # before the request reaches this service.
    if isinstance(value, str):
        return value.strip(), None
    return None, ManualBatchValidationFailure(
        input_index=0,
        row_number=None,
        tracking_no=None,
        tracking_no_normalized=None,
        error_code="INVALID_FIELD_TYPE",
        message="运单号必须是文本；Excel 运单号列必须按文本格式读取",
    )


def _optional_text(
    value: Any,
    *,
    default: str | None,
    maximum: int,
    error_code: BatchValidationCode,
    label: str,
) -> tuple[str | None, tuple[BatchValidationCode, str] | None]:
    if value is None:
        return default, None
    if not isinstance(value, str):
        return None, ("INVALID_FIELD_TYPE", f"{label}必须是文本")
    normalized = value.strip()
    if not normalized:
        return default, None
    if len(normalized) > maximum:
        return None, (error_code, f"{label}不能超过 {maximum} 个字符")
    return normalized, None


def validate_manual_batch_input(
    item: ManualBatchInput,
) -> ValidatedManualBatchInput | ManualBatchValidationFailure:
    tracking_no, tracking_type_failure = _tracking_text_value(item.tracking_no)
    if tracking_type_failure is not None:
        return ManualBatchValidationFailure(
            input_index=item.input_index,
            row_number=item.row_number,
            tracking_no=None,
            tracking_no_normalized=None,
            error_code=tracking_type_failure.error_code,
            message=tracking_type_failure.message,
        )
    if not tracking_no:
        return ManualBatchValidationFailure(
            input_index=item.input_index,
            row_number=item.row_number,
            tracking_no=tracking_no,
            tracking_no_normalized=None,
            error_code="MISSING_TRACKING",
            message="运单号不能为空",
        )
    if len(tracking_no) > 128:
        return ManualBatchValidationFailure(
            input_index=item.input_index,
            row_number=item.row_number,
            tracking_no=tracking_no[:128],
            tracking_no_normalized=None,
            error_code="TRACKING_TOO_LONG",
            message="运单号不能超过 128 个字符",
        )
    tracking_format_error = manual_tracking_format_error(tracking_no)
    if tracking_format_error is not None:
        return ManualBatchValidationFailure(
            input_index=item.input_index,
            row_number=item.row_number,
            tracking_no=tracking_no,
            tracking_no_normalized=None,
            error_code="INVALID_TRACKING",
            message=tracking_format_error,
        )
    tracking_normalized = normalize_manual_tracking_no(tracking_no)
    if (
        not 8 <= len(tracking_normalized) <= 32
        or not any(character.isdigit() for character in tracking_normalized)
    ):
        return ManualBatchValidationFailure(
            input_index=item.input_index,
            row_number=item.row_number,
            tracking_no=tracking_no,
            tracking_no_normalized=tracking_normalized or None,
            error_code="INVALID_TRACKING",
            message="规范化运单号必须为 8–32 位英文字母/数字，且至少包含一个数字",
        )

    product_name, product_error = _optional_text(
        item.product_name,
        default=DEFAULT_MANUAL_PRODUCT_NAME,
        maximum=256,
        error_code="PRODUCT_NAME_TOO_LONG",
        label="商品名称",
    )
    courier, courier_error = _optional_text(
        item.courier,
        default=None,
        maximum=128,
        error_code="COURIER_TOO_LONG",
        label="物流公司",
    )
    remark, remark_error = _optional_text(
        item.remark,
        default=None,
        maximum=512,
        error_code="REMARK_TOO_LONG",
        label="备注",
    )
    for error in (product_error, courier_error, remark_error):
        if error is not None:
            return ManualBatchValidationFailure(
                input_index=item.input_index,
                row_number=item.row_number,
                tracking_no=tracking_no,
                tracking_no_normalized=tracking_normalized,
                error_code=error[0],
                message=error[1],
            )

    # The product default is non-null by construction.
    assert product_name is not None
    return ValidatedManualBatchInput(
        input_index=item.input_index,
        row_number=item.row_number,
        tracking_no=tracking_no,
        tracking_no_normalized=tracking_normalized,
        product_name=product_name,
        courier=courier,
        remark=remark,
    )


def manual_batch_payload_digest(payload: ManualOrderBatchCreate) -> str:
    try:
        canonical = json.dumps(
            payload.model_dump(mode="json"),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="批量录入包含无效字段值") from exc
    return hashlib.sha256(canonical).hexdigest()


def manual_batch_event_id(client_batch_id: str, tracking_no_normalized: str) -> str:
    digest = hashlib.sha256(
        f"{client_batch_id}\0{tracking_no_normalized}".encode("utf-8")
    ).hexdigest()
    return f"manual-batch-{digest}"
