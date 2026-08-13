import type { Page } from "playwright";

import type { RawOrder, StatusMap } from "../extract/order.js";
import type {
  BlockState,
  LoginState,
  OrderListState,
  PlatformAdapter,
  SyncWindow,
} from "./base.js";

export const PDD_STATUS_MAP: StatusMap = {};

function notImplemented<T>(name: string): T {
  throw new Error(`pdd adapter "${name}" is not implemented until D4`);
}

export const pddAdapter: PlatformAdapter = {
  platform: "pdd",
  orderListUrl: "https://mobile.yangkeduo.com/orders.html",
  statusMap: PDD_STATUS_MAP,

  async openOrders(_page: Page, _window: SyncWindow): Promise<void> {
    notImplemented("openOrders");
  },

  async detectLogin(_page: Page): Promise<LoginState> {
    return notImplemented("detectLogin");
  },

  async detectBlock(_page: Page): Promise<BlockState> {
    return notImplemented("detectBlock");
  },

  async collectVisibleOrders(_page: Page): Promise<OrderListState> {
    return notImplemented("collectVisibleOrders");
  },

  async advancePage(_page: Page): Promise<boolean> {
    return notImplemented("advancePage");
  },
};

export type PddRawOrder = RawOrder;
