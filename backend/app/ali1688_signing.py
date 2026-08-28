from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping


def _string(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def sign_param2(path: str, params: Mapping[str, object], app_secret: str) -> str:
    """Return the 1688 param2 HMAC-SHA1 signature.

    The factor is the exact unescaped param2 path (including app key), followed
    by sorted key/value pairs. The result is uppercase hexadecimal. The
    signature field itself is excluded.
    """
    factors = "".join(
        f"{key}{_string(params[key])}"
        for key in sorted(params)
        if key not in {"sign", "_aop_signature"} and params[key] is not None
    )
    raw = f"{path}{factors}"
    return hmac.new(app_secret.encode("utf-8"), raw.encode("utf-8"), hashlib.sha1).hexdigest().upper()


def build_param2_request(path: str, params: Mapping[str, object], app_secret: str) -> dict[str, str]:
    result = {key: _string(value) for key, value in params.items() if value is not None}
    result["_aop_signature"] = sign_param2(path, result, app_secret)
    return result


generate_signature = sign_param2
