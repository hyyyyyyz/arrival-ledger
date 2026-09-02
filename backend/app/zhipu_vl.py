"""Small, optional Zhipu GLM-V client used as a barcode-recognition fallback.

The model is deliberately treated as a candidate generator only.  Callers must
cross-check the returned candidates against the platform package table before
persisting a tracking number.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable


logger = logging.getLogger(__name__)

API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z0-9][A-Za-z0-9 ._\-/]{6,38}[A-Za-z0-9])(?![A-Za-z0-9])")
_JSON_KEYS = {"tracking_no", "tracking_number", "tracking_numbers", "candidates", "运单号", "快递单号"}


def _normalise(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


def _append_candidate(value: Any, output: list[str]) -> None:
    if not isinstance(value, str):
        return
    normalised = _normalise(value)
    # Keep the parser permissive; the database resolver is the trust boundary.
    if 8 <= len(normalised) <= 32 and any(ch.isdigit() for ch in normalised):
        if normalised not in output:
            output.append(normalised)


def _walk_json(value: Any, output: list[str], *, in_candidate_field: bool = False) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key).lower()
            is_candidate_field = key_text in _JSON_KEYS or any(
                marker in key_text for marker in ("tracking", "运单", "快递单号")
            )
            _walk_json(child, output, in_candidate_field=is_candidate_field)
    elif isinstance(value, list):
        for child in value:
            _walk_json(child, output, in_candidate_field=in_candidate_field)
    elif in_candidate_field:
        _append_candidate(value, output)


def parse_tracking_candidates(text: str) -> list[str]:
    """Extract ordered, de-duplicated candidates from JSON or free-form output."""

    output: list[str] = []
    stripped = text.strip()
    if stripped:
        try:
            _walk_json(json.loads(stripped), output)
        except json.JSONDecodeError:
            pass
        for match in _TOKEN_RE.finditer(stripped):
            _append_candidate(match.group(1), output)
    return output


def _message_text(payload: dict[str, Any]) -> str:
    def flatten(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(flatten(item) for item in value)
        if isinstance(value, dict):
            return str(value.get("text", ""))
        return ""

    chunks: list[str] = []
    for choice in payload.get("choices", []):
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        for key in ("content", "reasoning_content"):
            value = flatten(message.get(key))
            if value:
                chunks.append(value)
    return "\n".join(chunks)


def extract_tracking_candidates(
    image_path: Path,
    *,
    api_key: str,
    model: str = "glm-4.1v-thinking-flash",
    timeout_seconds: float = 12.0,
    opener: Callable[..., Any] | None = None,
) -> list[str]:
    """Call GLM-V once and return untrusted tracking-number candidates.

    Network and provider failures intentionally return an empty list so a VL
    outage never prevents a photo from being stored or retried locally.
    """

    if not api_key.strip():
        return []
    try:
        encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
        suffix = image_path.suffix.lower()
        mime = "image/png" if suffix == ".png" else "image/webp" if suffix == ".webp" else "image/jpeg"
        body = {
            "model": model,
            "temperature": 0.0,
            "max_tokens": 600,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "请识别这张快递面单上真正的物流运单号。忽略订单号、手机号、"
                                "邮编、分拣码和日期。只返回 JSON："
                                '{"tracking_numbers":["候选号码"]}；看不清时返回空数组。'
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}},
                    ],
                }
            ],
        }
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key.strip()}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        open_url = opener or urllib.request.urlopen
        with open_url(request, timeout=timeout_seconds) as response:
            raw = response.read()
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            return []
        return parse_tracking_candidates(_message_text(payload))
    except (OSError, ValueError, TypeError, json.JSONDecodeError, urllib.error.URLError, TimeoutError) as exc:
        logger.warning("zhipu VL fallback unavailable: %s", type(exc).__name__)
        return []


def resolve_tracking_candidate(connection: Any, candidates: list[str]) -> tuple[str, str] | None:
    """Return ``(display_tracking_no, normalized)`` for a DB-backed candidate.

    Candidate order is used only as a tie-breaker.  A candidate must exist in
    ``packages``; otherwise it is rejected as untrusted model output.
    """

    ordered: list[str] = []
    for candidate in candidates:
        normalised = _normalise(candidate)
        if 8 <= len(normalised) <= 32 and normalised not in ordered:
            ordered.append(normalised)
    if not ordered:
        return None
    placeholders = ",".join("?" for _ in ordered)
    rows = connection.execute(
        f"""
        SELECT tracking_no, tracking_no_normalized, COUNT(*) AS package_count
        FROM packages
        WHERE tracking_no_normalized IN ({placeholders})
        GROUP BY tracking_no_normalized, tracking_no
        """,
        tuple(ordered),
    ).fetchall()
    by_normalized: dict[str, tuple[str, int]] = {}
    for row in rows:
        key = row["tracking_no_normalized"]
        display = row["tracking_no"]
        count = int(row["package_count"])
        current = by_normalized.get(key)
        if current is None or count > current[1]:
            by_normalized[key] = (display, count)
    if not by_normalized:
        return None
    # The model's first database-backed candidate wins. This is deterministic
    # and allows reasoning text to contain additional non-tracking numbers.
    for candidate in ordered:
        match = by_normalized.get(candidate)
        if match is not None:
            return match[0], candidate
    return None
