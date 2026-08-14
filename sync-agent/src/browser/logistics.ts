import type { Locator } from "playwright";

import {
  extractAllLabelMarkers,
  extractLabelValue,
  innermostContainers,
  nearestPrecedingLabelValue,
} from "./dom.js";
import { stripLabelPrefixAtStart } from "../extract/text.js";
import {
  normalizeTrackingNo,
  splitLogisticsCell,
  trackingFromLabeledText,
} from "../extract/tracking.js";
import type { RawOrderPackage } from "../extract/order.js";

export interface LogisticsSelectors {
  containerSelectors: readonly string[];
  courierLabels: readonly string[];
  trackingLabels: readonly string[];
}

export interface LogisticsParseResult {
  area_found: boolean;
  rows_seen: number;
  rows_parsed: number;
  unparsed_rows: number;
  packages: RawOrderPackage[];
}

export async function parseDetailLogistics(
  body: Locator,
  selectors: LogisticsSelectors,
): Promise<LogisticsParseResult> {
  const packages: RawOrderPackage[] = [];
  const seen = new Set<string>();
  let rowsSeen = 0;
  let rowsParsed = 0;
  let unparsedRows = 0;

  const add = (courier: string | null, tracking: string): void => {
    const key = normalizeTrackingNo(tracking);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    packages.push({ courier, tracking_no: tracking, status: null });
  };

  const trackingMarkers = await extractAllLabelMarkers(body, selectors.trackingLabels);
  for (const marker of trackingMarkers) {
    rowsSeen += 1;
    const ownText = await marker.innerText().catch(() => "");
    const stripped = stripLabelPrefixAtStart(ownText, selectors.trackingLabels);
    const rawValue = stripped.label_at_start ? stripped.value : ownText.trim();
    const tracking = trackingFromLabeledText(rawValue);
    if (tracking === null) {
      unparsedRows += 1;
      continue;
    }
    rowsParsed += 1;
    const courier = await nearestPrecedingLabelValue(marker, selectors.courierLabels);
    add(courier, tracking);
  }

  const containers = await innermostContainers(body, selectors.containerSelectors);
  for (const container of containers) {
    let hasTrackingLabel = false;
    for (const label of selectors.trackingLabels) {
      if ((await container.locator(`text=${label}`).count().catch(() => 0)) > 0) {
        hasTrackingLabel = true;
        break;
      }
    }
    if (hasTrackingLabel) continue;
    const text = (await container.innerText().catch(() => "")).trim();
    if (text.length === 0) continue;
    rowsSeen += 1;
    const split = splitLogisticsCell(text);
    if (split.tracking !== null) {
      rowsParsed += 1;
      const courier =
        (await extractLabelValue(container, selectors.courierLabels)) ?? split.courier;
      add(courier, split.tracking);
    } else {
      unparsedRows += 1;
    }
  }

  return {
    area_found: rowsSeen > 0,
    rows_seen: rowsSeen,
    rows_parsed: rowsParsed,
    unparsed_rows: unparsedRows,
    packages,
  };
}
