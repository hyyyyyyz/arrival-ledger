import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import type { Platform } from "../models.js";

export interface SanitizedDomNode {
  index: number;
  parent: number | null;
  depth: number;
  tag: string;
  class_tokens: string[];
  role: string | null;
  attribute_names: string[];
  markers: string[];
}

export interface SanitizedDomCapture {
  schema_version: 1;
  platform: Platform;
  captured_at: string;
  origin: string;
  pathname: string;
  truncated: boolean;
  nodes: SanitizedDomNode[];
}

const EXPECTED_ORIGINS: Record<Platform, string> = {
  pdd: "https://mobile.yangkeduo.com",
  "1688": "https://air.1688.com",
};

const SAFE_MARKERS = [
  "订单号",
  "订单编号",
  "下单账号",
  "下单时间",
  "货品",
  "单价",
  "数量",
  "总金额",
  "卖家",
  "订单状态",
  "交易操作",
  "订单详情",
  "待付款",
  "待发货",
  "待收货",
  "退款售后",
  "待评价",
  "已发货",
  "已收货",
  "交易成功",
  "交易关闭",
  "确认收货",
  "再次购买",
  "申请退款",
  "提醒发货",
  "下一页",
  "上一页",
] as const;

/**
 * Capture structural evidence only. Raw text, HTML, URLs, form values,
 * screenshots, cookies and storage are intentionally excluded.
 */
export async function captureSanitizedStructure(
  page: Page,
  platform: Platform,
  maxNodes = 12_000,
): Promise<SanitizedDomCapture> {
  const raw = await page.evaluate(
    ({ safeMarkers, max }) => {
      const skipTags = new Set(["script", "style", "noscript", "iframe", "object", "embed", "meta", "link"]);
      const allowedRoles = new Set([
        "article", "button", "cell", "columnheader", "dialog", "grid", "gridcell", "group",
        "heading", "link", "list", "listitem", "main", "navigation", "row", "rowgroup",
        "search", "status", "table", "tab", "tabpanel",
      ]);
      const allowedTags = new Set([
        "a", "article", "aside", "button", "caption", "dd", "div", "dl", "dt",
        "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
        "h4", "h5", "h6", "header", "img", "input", "label", "legend", "li",
        "main", "nav", "ol", "option", "p", "section", "select", "small", "span",
        "strong", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "time",
        "tr", "ul",
      ]);
      const allowedAriaNames = new Set([
        "aria-controls", "aria-current", "aria-describedby", "aria-disabled",
        "aria-expanded", "aria-haspopup", "aria-hidden", "aria-label", "aria-labelledby",
        "aria-selected",
      ]);
      const classAliases = new Map<string, string>();
      const nodes: Array<{
        index: number;
        parent: number | null;
        depth: number;
        tag: string;
        class_tokens: string[];
        role: string | null;
        attribute_names: string[];
        markers: string[];
      }> = [];
      let truncated = false;

      const visible = (element: Element): boolean => {
        const html = element as HTMLElement;
        const style = window.getComputedStyle(html);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        const rect = html.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
      };
      const classTokens = (element: Element): string[] => {
        const value = typeof element.className === "string" ? element.className : "";
        return value
          .split(/\s+/)
          .filter((token) => /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/.test(token))
          .slice(0, 12)
          .map((token) => {
            const known = classAliases.get(token);
            if (known !== undefined) return known;
            const alias = `class_${String(classAliases.size + 1).padStart(4, "0")}`;
            classAliases.set(token, alias);
            return alias;
          });
      };
      const markersFor = (element: Element): string[] => {
        const direct = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const markers: string[] = safeMarkers.filter((marker) => direct.includes(marker));
        if (/(?:订单号|订单编号)\s*[:：]?\s*[A-Za-z0-9-]{8,64}/.test(direct)) markers.push("[ORDER_ID]");
        if (/20\d{2}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}/.test(direct)) markers.push("[DATETIME]");
        if (/[¥￥]\s*\d/.test(direct)) markers.push("[AMOUNT]");
        return [...new Set(markers)];
      };
      const visit = (element: Element, parent: number | null, depth: number): void => {
        if (nodes.length >= max) {
          truncated = true;
          return;
        }
        const rawTag = element.tagName.toLowerCase();
        if (skipTags.has(rawTag) || !visible(element)) return;
        const tag = allowedTags.has(rawTag) ? rawTag : "custom";
        const index = nodes.length;
        const roleValue = (element.getAttribute("role") ?? "").toLowerCase();
        const attributeNames = [...new Set(element
          .getAttributeNames()
          .map((name) => {
            if (name === "role") return "role";
            if (allowedAriaNames.has(name)) return name;
            if (name.startsWith("data-")) return "data-*";
            return null;
          })
          .filter((name): name is string => name !== null))]
          .slice(0, 20);
        nodes.push({
          index,
          parent,
          depth,
          tag,
          class_tokens: classTokens(element),
          role: allowedRoles.has(roleValue) ? roleValue : null,
          attribute_names: attributeNames,
          markers: markersFor(element),
        });
        for (const child of Array.from(element.children)) {
          visit(child, index, depth + 1);
          if (truncated) break;
        }
      };
      visit(document.body, null, 0);
      return { nodes, truncated };
    },
    { safeMarkers: [...SAFE_MARKERS], max: Math.max(1, Math.min(maxNodes, 20_000)) },
  );

  let origin = "[REDACTED_ORIGIN]";
  try {
    const url = new URL(page.url());
    if (url.origin === EXPECTED_ORIGINS[platform]) origin = url.origin;
  } catch {
    // setContent/about:blank fixtures intentionally have no identifying URL.
  }
  return {
    schema_version: 1,
    platform,
    captured_at: new Date().toISOString(),
    origin,
    pathname: "/[REDACTED]",
    truncated: raw.truncated,
    nodes: raw.nodes,
  };
}

export function writeSanitizedCapture(stateDir: string, capture: SanitizedDomCapture): string {
  const directory = join(stateDir, "diagnostics");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error("diagnostics directory must not be a symbolic link");
  }
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows applies ACLs rather than POSIX modes; the directory remains local and gitignored.
  }
  const stamp = capture.captured_at.replaceAll(":", "-");
  const target = join(directory, `structure-${capture.platform}-${stamp}.json`);
  writeFileSync(target, `${JSON.stringify(capture, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    chmodSync(target, 0o600);
  } catch {
    // See Windows note above.
  }
  return target;
}
