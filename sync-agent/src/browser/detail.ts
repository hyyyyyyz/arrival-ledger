import type { Locator, Page } from "playwright";

export interface DetailLinkRules {
  textPatterns: RegExp[];
  hrefPatterns: RegExp[];
  excludeTextPatterns: RegExp[];
  excludeHrefPatterns: RegExp[];
  allowedHostSuffix: string;
}

export interface DetailTarget {
  link: Locator;
  href: string | null;
  opensNewTab: boolean;
}

export function officialHost(host: string, suffix: string): boolean {
  const lowered = host.toLowerCase();
  return lowered === suffix || lowered.endsWith(`.${suffix}`);
}

export function sameListUrl(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return (
      a.origin === b.origin &&
      a.pathname === b.pathname &&
      a.search === b.search &&
      a.hash === b.hash
    );
  } catch {
    return before === after;
  }
}

export function isOfficialHttpsUrl(url: string, hostSuffix: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && officialHost(parsed.hostname, hostSuffix);
  } catch {
    return false;
  }
}

export async function openDetailTarget(
  page: Page,
  target: DetailTarget,
): Promise<{ page: Page; newTab: boolean } | null> {
  const newPagePromise = page
    .context()
    .waitForEvent("page", { timeout: 4000 })
    .catch(() => null);
  try {
    await target.link.click({ timeout: 5000 });
  } catch {
    return null;
  }
  if (target.opensNewTab) {
    const newPage = await newPagePromise;
    if (newPage === null) return null;
    await newPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    await newPage.waitForTimeout(500);
    return { page: newPage, newTab: true };
  }
  const newPage = await Promise.race([
    newPagePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
  ]);
  if (newPage !== null) {
    await newPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    await newPage.waitForTimeout(500);
    return { page: newPage, newTab: true };
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(500);
  return { page, newTab: false };
}

export async function findDetailLink(
  card: Locator,
  pageUrl: string,
  rules: DetailLinkRules,
): Promise<DetailTarget | null> {
  const anchors = card.locator("a");
  const anchorCount = await anchors.count().catch(() => 0);
  const candidates: Array<{
    link: Locator;
    text: string;
    href: string | null;
    opensNewTab: boolean;
    score: number;
  }> = [];

  for (let index = 0; index < anchorCount; index += 1) {
    const link = anchors.nth(index);
    if (!(await link.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const text = (await link.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const rawHref = (await link.getAttribute("href").catch(() => null)) ?? null;
    const target = (await link.getAttribute("target").catch(() => null)) ?? null;
    const effectiveHref =
      rawHref !== null && !rawHref.toLowerCase().startsWith("javascript:")
        ? rawHref
        : null;
    if (rules.excludeTextPatterns.some((pattern) => pattern.test(text))) continue;
    if (effectiveHref !== null && rules.excludeHrefPatterns.some((pattern) => pattern.test(effectiveHref))) continue;
    if (effectiveHref === null) {
      if (rules.textPatterns.some((pattern) => pattern.test(text))) {
        candidates.push({
          link,
          text,
          href: null,
          opensNewTab: false,
          score: 2,
        });
      }
      continue;
    }
    let resolved: string;
    try {
      resolved = new URL(effectiveHref, pageUrl).href;
    } catch {
      continue;
    }
    if (!officialHost(new URL(resolved).hostname, rules.allowedHostSuffix)) continue;
    let score = 0;
    if (rules.textPatterns.some((pattern) => pattern.test(text))) score += 2;
    if (rules.hrefPatterns.some((pattern) => pattern.test(effectiveHref))) score += 1;
    if (score === 0 || (score === 1 && text.length === 0)) continue;
    candidates.push({
      link,
      text,
      href: resolved,
      opensNewTab: (target ?? "").toLowerCase() === "_blank",
      score,
    });
  }

  const buttons = card.locator("button");
  const buttonCount = await buttons.count().catch(() => 0);
  for (let index = 0; index < buttonCount; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) continue;
    if (!(await button.isEnabled({ timeout: 500 }).catch(() => false))) continue;
    const text = (await button.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (rules.excludeTextPatterns.some((pattern) => pattern.test(text))) continue;
    if (!rules.textPatterns.some((pattern) => pattern.test(text))) continue;
    candidates.push({ link: button, text, href: null, opensNewTab: false, score: 2 });
  }

  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates[0];
  if (chosen === undefined) return null;
  return { link: chosen.link, href: chosen.href, opensNewTab: chosen.opensNewTab };
}
