import type { Locator, Page } from "playwright";

import { stripLabelPrefixAtStart } from "../extract/text.js";

export async function countVisible(page: Page, selector: string): Promise<number> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible({ timeout: 500 }).catch(() => false)) {
      visible += 1;
    }
  }
  return visible;
}

export async function countVisibleMarkers(
  page: Page,
  markers: readonly string[],
): Promise<number> {
  let visible = 0;
  for (const marker of markers) {
    visible += await countVisible(page, marker);
  }
  return visible;
}

export async function extractLabelValue(
  container: Locator,
  labels: readonly string[],
): Promise<string | null> {
  for (const label of labels) {
    const marker = container.locator(`text=${label}`).first();
    if ((await marker.count()) === 0) continue;
    const ownText = await marker.innerText().catch(() => "");
    const stripped = stripLabelPrefixAtStart(ownText, [label]);
    if (stripped.label_at_start) {
      if (stripped.value.length > 0) return stripped.value;
      const siblingText = await marker
        .locator("xpath=following-sibling::*[1]")
        .first()
        .innerText()
        .catch(() => "");
      if (siblingText.trim().length > 0) return siblingText.trim();
      continue;
    }
    return stripped.value;
  }
  return null;
}

export async function extractFieldValue(
  container: Locator,
  labels: readonly string[],
  fallbackSelectors: readonly string[],
): Promise<string | null> {
  const labeled = await extractLabelValue(container, labels);
  if (labeled !== null) return labeled;
  for (const selector of fallbackSelectors) {
    const element = container.locator(selector).first();
    if ((await element.count()) === 0) continue;
    const text = await element.innerText().catch(() => "");
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export async function extractAllFieldValues(
  container: Locator,
  fallbackSelectors: readonly string[],
): Promise<string[]> {
  const values: string[] = [];
  for (const selector of fallbackSelectors) {
    const elements = container.locator(selector);
    const count = await elements.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (!(await elements.nth(index).isVisible({ timeout: 250 }).catch(() => false))) {
        continue;
      }
      const text = await elements.nth(index).innerText().catch(() => "");
      const trimmed = text.trim();
      if (trimmed.length > 0 && !values.includes(trimmed)) values.push(trimmed);
    }
  }
  return values;
}
