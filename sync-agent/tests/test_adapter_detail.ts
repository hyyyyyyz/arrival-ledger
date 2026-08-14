import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ali1688Adapter } from "../src/adapters/ali1688.js";
import type { UnparsedCard } from "../src/adapters/base.js";
import { checkPageState } from "../src/browser/guards.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "1688");

let browser: import("playwright").Browser;
let page: Page;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url === "/" ? "/order-list-partial.html" : request.url ?? "/";
    const relative = path.startsWith("/") ? path.slice(1) : path;
    try {
      const body = readFileSync(join(fixtureDir, relative), "utf8");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
  server.close();
});

describe("order detail fallback over visible DOM", () => {
  it("collects unparsed cards and resolves them through the detail page", async () => {
    await page.goto(baseUrl);
    const state = await checkPageState(page, ali1688Adapter);
    expect(state.status).toBe("OK");

    const list = await ali1688Adapter.collectVisibleOrders(page);
    expect(list.rows_seen).toBe(1);
    expect(list.recognized).toBe(0);
    expect(list.unparsed).toHaveLength(1);
    expect(list.unparsed[0]?.missing).toContain("order_id");

    const card = list.unparsed[0]!;
    const detail = await ali1688Adapter.readOrderDetail(page, card);
    expect(detail).not.toBeNull();
    expect(detail?.platform_order_id).toBe("1688-260813-0002");
    expect(detail?.items[0]?.title).toBe("测试商品丙");
    expect(detail?.shop_name).toBe("测试供应商乙");
    expect(detail?.packages).toHaveLength(1);
    expect(detail?.packages[0]?.courier).toBe("顺丰速运");
    expect(detail?.packages[0]?.tracking_no).toBe("SF-20260813-0002");

    const back = await checkPageState(page, ali1688Adapter);
    expect(back.status).toBe("OK");
    const again = await ali1688Adapter.collectVisibleOrders(page);
    expect(again.rows_seen).toBe(1);
  });

  it("returns null when the page does not return to the list", async () => {
    const fresh = await browser.newPage();
    try {
      await fresh.goto(`${baseUrl}/detail.html`);
      const card: UnparsedCard = {
        locator: fresh.locator("body"),
        missing: ["order_id"],
        hint: "x",
      };
      const detail = await ali1688Adapter.readOrderDetail(fresh, card);
      expect(detail).toBeNull();
    } finally {
      await fresh.close();
    }
  });
});
