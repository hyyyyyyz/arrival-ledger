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
    if (!(await marker.isVisible({ timeout: 500 }).catch(() => false))) continue;
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
    const elements = container.locator(selector);
    const count = await elements.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (!(await elements.nth(index).isVisible({ timeout: 500 }).catch(() => false))) {
        continue;
      }
      const text = await elements.nth(index).innerText().catch(() => "");
      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

export async function extractAllLabelValues(
  container: Locator,
  labels: readonly string[],
): Promise<string[]> {
  const values: string[] = [];
  for (const label of labels) {
    const markers = container.locator(`text=${label}`);
    const count = await markers.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const marker = markers.nth(index);
      if (!(await marker.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const ownText = await marker.innerText().catch(() => "");
      const stripped = stripLabelPrefixAtStart(ownText, [label]);
      if (stripped.label_at_start && stripped.value.length > 0) {
        if (!values.includes(stripped.value)) values.push(stripped.value);
      }
    }
  }
  return values;
}

export async function extractFieldValueStructuralFirst(
  container: Locator,
  labels: readonly string[],
  fallbackSelectors: readonly string[],
): Promise<string | null> {
  for (const selector of fallbackSelectors) {
    const elements = container.locator(selector);
    const count = await elements.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (!(await elements.nth(index).isVisible({ timeout: 500 }).catch(() => false))) {
        continue;
      }
      const text = await elements.nth(index).innerText().catch(() => "");
      const trimmed = text.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return extractLabelValue(container, labels);
}

export async function nearestPrecedingByClass(
  container: Locator,
  classKeywords: readonly string[],
): Promise<Locator | null> {
  const conditions = classKeywords
    .map((keyword) => `contains(@class, '${keyword}')`)
    .join(" or ");
  const candidate = container
    .locator(`xpath=preceding-sibling::*[${conditions}][1]`)
    .first();
  if ((await candidate.count()) === 0) return null;
  if (!(await candidate.isVisible({ timeout: 500 }).catch(() => false))) return null;
  return candidate;
}

export async function innermostContainers(
  container: Locator,
  selectors: readonly string[],
): Promise<Locator[]> {
  const all = container.locator([...selectors].join(", "));
  const count = await all.count().catch(() => 0);
  const containers: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = all.nth(index);
    if (!(await candidate.isVisible({ timeout: 500 }).catch(() => false))) continue;
    const nested = await candidate.locator([...selectors].join(", ")).count().catch(() => 0);
    if (nested > 0) continue;
    containers.push(candidate);
  }
  return containers;
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
      if (trimmed.length > 0) values.push(trimmed);
    }
  }
  return values;
}
