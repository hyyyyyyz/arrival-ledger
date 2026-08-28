"""Small Docker-friendly CLI for the official 1688 sync."""
from __future__ import annotations

import argparse
import json
import os
import sys

from .ali1688_config import Ali1688ConfigError, load_config
from .ali1688_client import ClientLimits
from .ali1688_sync import sync_config
from .config import Settings
from .database import Database
from .main import db_timestamp, utc_now


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="arrival-manager")
    sub = root.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("config-doctor", help="validate 1688 configuration without printing secrets")
    doctor.add_argument("--config", dest="config_path")
    sync = sub.add_parser("sync-once")
    sync.add_argument("--account")
    sync.add_argument("--all", action="store_true")
    sync.add_argument("--dry-run", action="store_true")
    return root


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv[:2] == ["config", "doctor"]:
        argv = ["config-doctor", *argv[2:]]
    args = parser().parse_args(argv)
    try:
        config_path = getattr(args, "config_path", None) or os.getenv(
            "ALI1688_CONFIG_PATH", "/run/secrets/ali1688.json"
        )
        # Doctor and manual dry-runs must be useful before the scheduler is
        # enabled, so loading the file is intentionally independent of
        # ALI1688_API_ENABLED.
        config = load_config(config_path)
        if args.command == "config-doctor":
            print(json.dumps({"enabled": config.enabled, "apps": len(config.apps), "accounts": len(config.accounts())}, ensure_ascii=False))
            return 0
        if not config.enabled:
            print("configuration error: 1688 secret config has no authorized accounts", file=sys.stderr)
            return 2
        if args.command == "sync-once" and args.account and args.all:
            print("choose --account or --all", file=sys.stderr)
            return 2
        if args.command == "sync-once" and not args.account and not args.all:
            print("sync-once requires --account KEY or --all", file=sys.stderr)
            return 2
        settings = Settings.from_env()
        database = Database(settings.database_path)
        database.initialize(bootstrap_username=settings.bootstrap_admin_username, bootstrap_password=settings.bootstrap_admin_password, bootstrap_display_name=settings.bootstrap_admin_display_name, session_secret=settings.session_secret, sync_worker_tokens=settings.sync_worker_tokens, now=db_timestamp(utc_now()))
        results = sync_config(
            database,
            config,
            account_key=args.account,
            dry_run=args.dry_run,
            max_pages=settings.ali1688_max_pages,
            backfill_days=settings.ali1688_backfill_days,
            client_limits=ClientLimits(
                timeout_seconds=settings.ali1688_timeout_seconds,
                retries=settings.ali1688_retries,
            ),
        )
        print(json.dumps(results, ensure_ascii=False))
        return 0 if all(r.get("status") in {"OK", "DRY_RUN", "SKIPPED"} for r in results) else 1
    except (Ali1688ConfigError, ValueError) as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
