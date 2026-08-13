import { cleanText } from "../normalize.js";

export { cleanText };

export interface TextMatch {
  found: boolean;
  value: string;
}

export function firstNonEmpty(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const cleaned = cleanText(candidate);
    if (cleaned.length > 0) return cleaned;
  }
  return null;
}

export function labelPatterns(labels: readonly string[]): RegExp[] {
  return labels.map((label) => new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

export function matchesAnyLabel(text: string, labels: readonly string[]): boolean {
  return labelPatterns(labels).some((pattern) => pattern.test(cleanText(text)));
}

export function stripLabelPrefix(text: string, labels: readonly string[]): string {
  const cleaned = cleanText(text);
  for (const pattern of labelPatterns(labels)) {
    if (pattern.test(cleaned)) {
      const stripped = cleaned.replace(pattern, " ").trim();
      const separator = stripped.match(/^[\s:：=]*/);
      if (separator !== null) return stripped.slice(separator[0].length).trim();
      return stripped;
    }
  }
  return cleaned;
}

export function limitChars(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}
