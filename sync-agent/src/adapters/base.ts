import type { Locator, Page } from "playwright";

import type { Platform } from "../models.js";
import type { RawOrder, StatusMap } from "../extract/order.js";

export interface LoginState {
  logged_in: boolean;
  detail: string;
}

export interface BlockState {
  blocked: boolean;
  kind: "captcha" | "risk" | "login-wall" | "unknown";
  detail: string;
}

export interface SyncWindow {
  max_pages: number;
  max_records: number;
  order_list_url?: string;
}

export interface CollectOptions {
  skip_order_ids?: ReadonlySet<string>;
}

export interface UnparsedCard {
  locator: Locator;
  missing: Array<"order_id" | "logistics">;
  hint: string;
  order_id?: string | null;
  summary?: {
    ordered_at: string | null;
    status: string | null;
    shop_name: string | null;
    items: RawOrder["items"];
  };
}

export interface OrderListState {
  orders: RawOrder[];
  empty: boolean;
  rows_seen: number;
  recognized: number;
  unparsed: UnparsedCard[];
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly orderListUrl: string;
  readonly statusMap: StatusMap;
  /**
   * Whether the automatic sync flow may leave the order-list page to enrich
   * an order.  Adapters that are sensitive to action-level verification must
   * keep this false; a dry-run then remains strictly list-only.
   */
  readonly allowDetailNavigation?: boolean;
  openOrders(page: Page, window: SyncWindow): Promise<void>;
  detectLogin(page: Page): Promise<LoginState>;
  detectBlock(page: Page): Promise<BlockState>;
  collectVisibleOrders(page: Page, options?: CollectOptions): Promise<OrderListState>;
  advancePage(page: Page): Promise<boolean>;
  readOrderDetail(page: Page, card: UnparsedCard): Promise<RawOrder | null>;
}
