from __future__ import annotations

import os
from dataclasses import dataclass
from ipaddress import ip_network
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _env_int(name: str, default: int, minimum: int) -> int:
    raw = os.getenv(name)
    value = default if raw is None else int(raw)
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _env_networks(name: str, default: str) -> tuple[str, ...]:
    raw = os.getenv(name, default)
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    if not values:
        raise ValueError(f"{name} must contain at least one network")
    for value in values:
        try:
            ip_network(value, strict=False)
        except ValueError as exc:
            raise ValueError(f"{name} contains an invalid network: {value}") from exc
    return values


def _env_values(name: str, default: str) -> tuple[str, ...]:
    values = tuple(
        item.strip().lower()
        for item in os.getenv(name, default).split(",")
        if item.strip()
    )
    if not values:
        raise ValueError(f"{name} must contain at least one value")
    return values


@dataclass(frozen=True)
class Settings:
    database_path: Path
    media_dir: Path
    session_secret: str
    auth_required: bool = True
    trusted_user_username: str = "admin"
    trusted_lan_cidrs: tuple[str, ...] = ("192.168.1.0/24",)
    trusted_hosts: tuple[str, ...] = ("192.168.1.5", "localhost", "127.0.0.1")
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_password: str | None = None
    bootstrap_admin_display_name: str = "管理员"
    cookie_secure: bool = False
    cookie_name: str = "arrival_session"
    session_ttl_seconds: int = 60 * 60 * 24 * 30
    max_upload_bytes: int = 12 * 1024 * 1024
    sync_worker_tokens: tuple[str, ...] = ()
    sync_rate_limit_per_hour: int = 6
    sync_max_batch_orders: int = 100
    sync_max_batch_bytes: int = 256 * 1024

    def validate(self) -> None:
        if len(self.session_secret) < 32:
            raise ValueError("SESSION_SECRET must contain at least 32 characters")
        if not self.trusted_user_username.strip():
            raise ValueError("TRUSTED_USER_USERNAME cannot be blank")
        for cidr in self.trusted_lan_cidrs:
            try:
                ip_network(cidr, strict=False)
            except ValueError as exc:
                raise ValueError(f"TRUSTED_LAN_CIDRS contains an invalid network: {cidr}") from exc
        if not self.trusted_hosts:
            raise ValueError("TRUSTED_HOSTS must contain at least one host")
        if not self.bootstrap_admin_username.strip():
            raise ValueError("BOOTSTRAP_ADMIN_USERNAME cannot be blank")
        if self.bootstrap_admin_password is not None and len(
            self.bootstrap_admin_password.encode("utf-8")
        ) > 72:
            raise ValueError("BOOTSTRAP_ADMIN_PASSWORD exceeds bcrypt's 72-byte limit")
        for token in self.sync_worker_tokens:
            if len(token) < 16:
                raise ValueError(
                    "SYNC_WORKER_TOKENS entries must contain at least 16 characters"
                )
        if not 1 <= self.sync_rate_limit_per_hour <= 60:
            raise ValueError("SYNC_RATE_LIMIT_PER_HOUR must be between 1 and 60")
        if not 1 <= self.sync_max_batch_orders <= 100:
            raise ValueError("SYNC_MAX_BATCH_ORDERS must be between 1 and 100")
        if not 4096 <= self.sync_max_batch_bytes <= 2 * 1024 * 1024:
            raise ValueError("SYNC_MAX_BATCH_BYTES must be between 4096 and 2097152")

    @classmethod
    def from_env(cls) -> "Settings":
        secret = os.getenv("SESSION_SECRET", "")
        bootstrap_username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", "admin")
        settings = cls(
            database_path=Path(
                os.getenv("DATABASE_PATH", "/data/db/arrival-manager.db")
            ),
            media_dir=Path(os.getenv("MEDIA_DIR", "/data/media")),
            session_secret=secret,
            auth_required=_env_bool("AUTH_REQUIRED", True),
            trusted_user_username=os.getenv(
                "TRUSTED_USER_USERNAME", bootstrap_username
            ),
            trusted_lan_cidrs=_env_networks(
                "TRUSTED_LAN_CIDRS", "192.168.1.0/24,127.0.0.1/32,::1/128"
            ),
            trusted_hosts=_env_values(
                "TRUSTED_HOSTS", "192.168.1.5,localhost,127.0.0.1"
            ),
            bootstrap_admin_username=bootstrap_username,
            bootstrap_admin_password=os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or None,
            bootstrap_admin_display_name=os.getenv(
                "BOOTSTRAP_ADMIN_DISPLAY_NAME", "管理员"
            ),
            cookie_secure=_env_bool("COOKIE_SECURE", False),
            cookie_name=os.getenv("COOKIE_NAME", "arrival_session"),
            session_ttl_seconds=_env_int(
                "SESSION_TTL_SECONDS", 60 * 60 * 24 * 30, 60
            ),
            max_upload_bytes=_env_int(
                "MAX_UPLOAD_BYTES", 12 * 1024 * 1024, 1024
            ),
            sync_worker_tokens=tuple(
                token.strip()
                for token in os.getenv("SYNC_WORKER_TOKENS", "").split(",")
                if token.strip()
            ),
            sync_rate_limit_per_hour=_env_int(
                "SYNC_RATE_LIMIT_PER_HOUR", 6, 1
            ),
            sync_max_batch_orders=_env_int("SYNC_MAX_BATCH_ORDERS", 100, 1),
            sync_max_batch_bytes=_env_int(
                "SYNC_MAX_BATCH_BYTES", 256 * 1024, 4096
            ),
        )
        settings.validate()
        return settings
