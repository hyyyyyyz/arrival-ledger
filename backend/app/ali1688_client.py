from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx2 as httpx

from .ali1688_config import Ali1688Account, Ali1688App
from .ali1688_signing import build_param2_request

DEFAULT_BASE_URL = "https://gw.open.1688.com/openapi"


class Ali1688Error(RuntimeError):
    code = "API_ERROR"


class Ali1688AuthError(Ali1688Error):
    code = "AUTH_ERROR"


class Ali1688PermissionError(Ali1688Error):
    code = "PERMISSION_ERROR"


class Ali1688ValidationError(Ali1688Error):
    code = "VALIDATION_ERROR"


class Ali1688TransientError(Ali1688Error):
    code = "TRANSIENT_ERROR"


@dataclass(frozen=True)
class ClientLimits:
    timeout_seconds: float = 15.0
    retries: int = 2
    response_bytes: int = 2 * 1024 * 1024
    base_backoff_seconds: float = 0.25


def classify_error(status_code: int, payload: Any) -> type[Ali1688Error]:
    if status_code == 401:
        return Ali1688AuthError
    if status_code == 403:
        return Ali1688PermissionError
    text = json.dumps(payload, ensure_ascii=False)[:500].lower()
    # Alibaba may return gateway errors in a HTTP 200 JSON envelope.  Classify
    # known transient codes before the broad validation fallback so SYSTEM_BUSY
    # and throttling receive the same bounded retry policy as 429/5xx.
    if status_code == 429 or status_code >= 500 or any(
        marker in text
        for marker in (
            "system_busy",
            "service_unavailable",
            "gateway_timeout",
            "request_timeout",
            "flow_limit",
            "throttl",
            "系统繁忙",
            "服务不可用",
        )
    ):
        return Ali1688TransientError
    if any(marker in text for marker in ("invalid_access_token", "token_expired", "access_token", "令牌失效")):
        return Ali1688AuthError
    if any(marker in text for marker in ("no_permission", "permission_denied", "forbidden", "未授权", "权限")):
        return Ali1688PermissionError
    if status_code >= 400 or any(word in text for word in ("invalid", "参数", "error", "错误")):
        return Ali1688ValidationError
    return Ali1688Error


class Ali1688Client:
    def __init__(
        self,
        app: Ali1688App,
        account: Ali1688Account,
        *,
        base_url: str = DEFAULT_BASE_URL,
        limits: ClientLimits | None = None,
        transport: Any | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now_ms: Callable[[], int] | None = None,
        include_aop_timestamp: bool = True,
        # app_key is already an URL-path factor in param2.  The official
        # Alibaba SDK therefore does not duplicate it as a form field.
        include_app_key: bool = False,
        include_date_pattern: bool = False,
    ):
        self.app = app
        self.account = account
        self.base_url = base_url.rstrip("/")
        self.limits = limits or ClientLimits()
        self.transport = transport
        self.sleep = sleep
        self.now_ms = now_ms or (lambda: int(time.time() * 1000))
        self.include_aop_timestamp = include_aop_timestamp
        self.include_app_key = include_app_key
        self.include_date_pattern = include_date_pattern
        self._http_client = (
            None
            if transport is not None
            else httpx.Client(timeout=self.limits.timeout_seconds)
        )

    def close(self) -> None:
        """Release the pooled network connections owned by this client."""
        if self._http_client is not None:
            self._http_client.close()
            self._http_client = None

    def _call(self, method_name: str, params: dict[str, object]) -> Any:
        path = f"param2/1/com.alibaba.trade/{method_name}/{self.app.app_key}"
        request_params: dict[str, object] = {
            **params,
            "access_token": self.account.access_token,
        }
        if self.include_aop_timestamp:
            request_params["_aop_timestamp"] = str(self.now_ms())
        if self.include_app_key:
            request_params["app_key"] = self.app.app_key
        if self.include_date_pattern:
            request_params["_aop_datePattern"] = "yyyyMMddHHmmssSSS+0800"
        form = build_param2_request(path, request_params, self.app.app_secret)
        url = self.base_url.rstrip("/") + "/" + path
        last: Exception | None = None
        for attempt in range(self.limits.retries + 1):
            try:
                if self.transport is not None:
                    response = self.transport.post(url, data=form, timeout=self.limits.timeout_seconds)
                else:
                    if self._http_client is None:
                        raise RuntimeError("1688 client is closed")
                    response = self._http_client.post(url, data=form)
                content = getattr(response, "content", b"")
                if len(content) > self.limits.response_bytes:
                    raise Ali1688ValidationError("response exceeds configured limit")
                try:
                    body = response.json()
                except (ValueError, json.JSONDecodeError) as exc:
                    raise Ali1688ValidationError("1688 response is not JSON") from exc
                if response.status_code >= 400:
                    error_type = classify_error(response.status_code, body)
                    raise error_type("1688 request failed")
                if not isinstance(body, dict):
                    raise Ali1688ValidationError("1688 response must be an object")
                if any(key in body for key in ("error_code", "errorCode", "error_message", "errorMessage", "error_response")):
                    error_type = classify_error(response.status_code, body)
                    raise error_type("1688 API returned an error")
                result = body.get("result")
                if isinstance(result, dict) and any(key in result for key in ("error_code", "errorCode", "error_message", "errorMessage", "error_response")):
                    raise classify_error(response.status_code, result)("1688 API returned an error")
                return body
            except Ali1688TransientError as exc:
                last = exc
            except (httpx.TimeoutException, httpx.NetworkError, TimeoutError, OSError) as exc:
                last = Ali1688TransientError("1688 network request failed")
            if attempt < self.limits.retries:
                self.sleep(self.limits.base_backoff_seconds * (2 ** attempt) * (0.8 + random.random() * 0.4))
        assert last is not None
        raise last

    def get_buyer_order_list(
        self,
        *,
        create_start_time: str | None = None,
        create_end_time: str | None = None,
        modify_start_time: str | None = None,
        modify_end_time: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> Any:
        if page < 1 or page_size < 1 or page_size > 20:
            raise ValueError("page/page_size outside 1688 limits")
        return self._call("alibaba.trade.getBuyerOrderList", {
            "createStartTime": create_start_time,
            "createEndTime": create_end_time,
            "modifyStartTime": modify_start_time,
            "modifyEndTime": modify_end_time,
            "page": page,
            "pageSize": page_size,
        })

    def get_buyer_view(self, order_id: str, *, include_fields: str = "NativeLogistics") -> Any:
        if not isinstance(order_id, str) or not order_id.strip():
            raise ValueError("order_id is required")
        return self._call("alibaba.trade.get.buyerView", {
            "webSite": "1688",
            "orderId": order_id,
            "includeFields": include_fields,
        })

    list_orders = get_buyer_order_list
    buyer_view = get_buyer_view
