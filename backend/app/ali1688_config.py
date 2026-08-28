"""Configuration for the server-side 1688 Open API integration.

The config is deliberately a file, rather than database rows: access tokens and
application secrets must never be copied into a backup or exposed by a status
endpoint. repr on all objects is safe for diagnostics.
"""
from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class Ali1688ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Ali1688Account:
    account_key: str
    access_token: str
    display_label: str | None = None

    def __repr__(self) -> str:
        return f"Ali1688Account(account_key={self.account_key!r}, display_label={self.display_label!r}, access_token=<redacted>)"


@dataclass(frozen=True)
class Ali1688App:
    app_key: str
    app_secret: str
    accounts: tuple[Ali1688Account, ...]
    display_label: str | None = None

    def __repr__(self) -> str:
        return f"Ali1688App(app_key={self.app_key!r}, display_label={self.display_label!r}, accounts={len(self.accounts)})"


@dataclass(frozen=True)
class Ali1688Config:
    apps: tuple[Ali1688App, ...] = ()

    @property
    def enabled(self) -> bool:
        return bool(self.apps and any(app.accounts for app in self.apps))

    def accounts(self) -> tuple[tuple[Ali1688App, Ali1688Account], ...]:
        return tuple((app, account) for app in self.apps for account in app.accounts)

    def account(self, key: str) -> tuple[Ali1688App, Ali1688Account] | None:
        return next((pair for pair in self.accounts() if pair[1].account_key == key), None)


def _text(obj: Any, name: str, *, required: bool = True, max_len: int = 512) -> str | None:
    if obj is None and not required:
        return None
    if not isinstance(obj, str) or not obj.strip():
        raise Ali1688ConfigError(f"{name} must be a non-empty string")
    value = obj.strip()
    if len(value) > max_len:
        raise Ali1688ConfigError(f"{name} is too long")
    return value


def parse_config(raw: Any) -> Ali1688Config:
    if raw in (None, {}, {"apps": []}):
        return Ali1688Config()
    if not isinstance(raw, dict) or not isinstance(raw.get("apps"), list):
        raise Ali1688ConfigError("1688 secret config must contain an apps array")
    apps: list[Ali1688App] = []
    app_keys: set[str] = set()
    account_keys: set[str] = set()
    for i, app_raw in enumerate(raw["apps"]):
        if not isinstance(app_raw, dict):
            raise Ali1688ConfigError(f"apps[{i}] must be an object")
        app_key = _text(app_raw.get("app_key"), f"apps[{i}].app_key")
        app_secret = _text(app_raw.get("app_secret"), f"apps[{i}].app_secret")
        assert app_key is not None
        if app_key in app_keys:
            raise Ali1688ConfigError(f"duplicate app_key in apps[{i}]")
        app_keys.add(app_key)
        raw_accounts = app_raw.get("accounts", [])
        if not isinstance(raw_accounts, list):
            raise Ali1688ConfigError(f"apps[{i}].accounts must be an array")
        if len(raw_accounts) > 5:
            raise Ali1688ConfigError(
                f"apps[{i}].accounts exceeds the current 1688 limit of 5 authorized users"
            )
        accounts: list[Ali1688Account] = []
        for j, account_raw in enumerate(raw_accounts):
            if not isinstance(account_raw, dict):
                raise Ali1688ConfigError(f"apps[{i}].accounts[{j}] must be an object")
            key = _text(
                account_raw.get("account_key"),
                f"apps[{i}].accounts[{j}].account_key",
                max_len=64,
            )
            token = _text(account_raw.get("access_token"), f"apps[{i}].accounts[{j}].access_token")
            assert key is not None and token is not None
            if re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", key) is None:
                raise Ali1688ConfigError(
                    f"apps[{i}].accounts[{j}].account_key must use lowercase letters, digits, dot, underscore or hyphen"
                )
            if key in account_keys:
                raise Ali1688ConfigError(f"duplicate account_key: {key}")
            account_keys.add(key)
            label = _text(account_raw.get("display_label"), "display_label", required=False, max_len=128)
            accounts.append(Ali1688Account(key, token, label))
        assert app_secret is not None
        label = _text(app_raw.get("display_label"), "display_label", required=False, max_len=128)
        apps.append(Ali1688App(app_key, app_secret, tuple(accounts), label))
    return Ali1688Config(tuple(apps))


def load_config(path: str | Path | None) -> Ali1688Config:
    """Load a secret file. Missing/empty files intentionally disable integration."""
    if path is None:
        return Ali1688Config()
    file_path = Path(path)
    descriptor: int | None = None
    try:
        flags = os.O_RDONLY
        if os.name == "posix" and hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(file_path, flags)
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode):
            raise Ali1688ConfigError(
                "1688 secret config must be a regular file, not a symlink"
            )
        if os.name != "posix" and file_path.is_symlink():
            raise Ali1688ConfigError(
                "1688 secret config must be a regular file, not a symlink"
            )
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = None
            content = handle.read()
        if not content:
            return Ali1688Config()
        data = json.loads(content)
    except FileNotFoundError:
        return Ali1688Config()
    except Ali1688ConfigError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise Ali1688ConfigError("cannot read 1688 secret config") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    config = parse_config(data)
    if config.apps and os.name == "posix":
        mode = stat.S_IMODE(file_stat.st_mode)
        if mode not in {0o600, 0o640}:
            raise Ali1688ConfigError(
                "1688 secret config permissions must be 0600 or 0640"
            )
    return config


def config_from_env() -> Ali1688Config:
    enabled = os.getenv("ALI1688_API_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
    if not enabled:
        return Ali1688Config()
    return load_config(os.getenv("ALI1688_CONFIG_PATH", "/run/secrets/ali1688.json"))


load_ali1688_config = load_config
