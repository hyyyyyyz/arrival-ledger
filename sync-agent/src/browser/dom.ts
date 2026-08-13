import type { Locator } from "playwright";

import { stripLabelPrefix } from "../extract/text.js";

export async function extractLabelValue(
  container: Locator,
  labels: readonly string[],
): Promise<string | null> {
  for (const label of labels) {
    const marker = container.locator(`:has-text("${label}")`).first();
    if ((await marker.count()) === 0) continue;
    const ownText = await marker.innerText().catch(() => "");
    const stripped = stripLabelPrefix(ownText, [label]);
    if (stripped.length > 0) return stripped;
    const siblingText = await marker
      .locator("xpath=following-sibling::*[1]")
      .first()
      .innerText()
      .catch(() => "");
    if (siblingText.trim().length > 0) return siblingText.trim();
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
