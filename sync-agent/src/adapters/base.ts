import type { Page } from "playwright";

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
}

export interface OrderListState {
  orders: RawOrder[];
  empty: boolean;
  rows_seen: number;
  recognized: number;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly orderListUrl: string;
  readonly statusMap: StatusMap;
  openOrders(page: Page, window: SyncWindow): Promise<void>;
  detectLogin(page: Page): Promise<LoginState>;
  detectBlock(page: Page): Promise<BlockState>;
  collectVisibleOrders(page: Page): Promise<OrderListState>;
  advancePage(page: Page): Promise<boolean>;
}
