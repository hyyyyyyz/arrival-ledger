import type { SyncBatch, ValidationIssue } from "./models.js";
import { SCHEMA_VERSION, validateBatch } from "./models.js";

export interface IngestResponse {
  batch_id: string;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  cursor_accepted: boolean;
}

export interface TransportOptions {
  api_base_url: string;
  worker_key: string;
  max_retries?: number;
  backoff_ms?: number;
  timeout_ms?: number;
}

export class TransportError extends Error {
  readonly kind:
    | "auth"
    | "revoked"
    | "conflict"
    | "validation"
    | "too_large"
    | "rate_limited"
    | "server"
    | "network"
    | "bad_response";
  readonly status: number | null;
  readonly retry_after_seconds: number | null;

  constructor(
    kind: TransportError["kind"],
    message: string,
    options: { status?: number | null; retry_after_seconds?: number | null } = {},
  ) {
    super(message);
    this.name = "TransportError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retry_after_seconds = options.retry_after_seconds ?? null;
  }
}

function mapStatus(status: number, retryAfter: number | null): TransportError {
  switch (status) {
    case 401:
      return new TransportError("auth", "server rejected the worker key (401)");
    case 403:
      return new TransportError("revoked", "worker key revoked or scope not allowed (403)");
    case 409:
      return new TransportError("conflict", "batch_id was already used with different content (409)");
    case 413:
      return new TransportError("too_large", "batch exceeds the server size limit (413)");
    case 422:
      return new TransportError("validation", "batch failed server validation (422)");
    case 429:
      return new TransportError(
        "rate_limited",
        `server rate limit exceeded (429)${retryAfter === null ? "" : `, retry after ${retryAfter}s`}`,
        { retry_after_seconds: retryAfter },
      );
    default:
      return new TransportError("server", `server returned status ${status}`, { status });
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function validateBatchForSubmission(batch: unknown): ValidationIssue[] {
  return validateBatch(batch);
}

export function isRetryable(error: TransportError): boolean {
  if (error.kind === "rate_limited") {
    return error.retry_after_seconds === null || error.retry_after_seconds < 60;
  }
  return error.kind === "server" || error.kind === "network";
}

export async function postBatch(
  options: TransportOptions,
  batch: SyncBatch,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestResponse> {
  const issues = validateBatchForSubmission(batch);
  if (issues.length > 0) {
    throw new TransportError(
      "validation",
      `client-side validation failed: ${issues.map((issue) => issue.path).join(", ")}`,
    );
  }
  if (batch.schema_version !== SCHEMA_VERSION) {
    throw new TransportError("validation", "schema_version mismatch");
  }
  if (batch.mode !== "commit") {
    throw new TransportError("validation", "only commit batches may be submitted");
  }
  if (options.worker_key.length === 0) {
    throw new TransportError("auth", "worker key is not configured");
  }

  const maxRetries = options.max_retries ?? 2;
  const backoffMs = options.backoff_ms ?? 5000;
  const timeoutMs = options.timeout_ms ?? 30_000;
  const url = `${options.api_base_url.replace(/\/+$/, "")}/api/sync/v1/batches`;
  const body = JSON.stringify(batch);

  let lastError: TransportError = new TransportError("network", "no request was attempted");
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      await delay(backoffMs * 2 ** (attempt - 1));
    }
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.worker_key}`,
          "Idempotency-Key": batch.batch_id,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (response.status === 200) {
        const parsed = (await response.json()) as Partial<IngestResponse>;
        if (
          typeof parsed.batch_id !== "string" ||
          typeof parsed.created !== "number" ||
          typeof parsed.updated !== "number" ||
          typeof parsed.skipped !== "number" ||
          !Array.isArray(parsed.errors) ||
          typeof parsed.cursor_accepted !== "boolean"
        ) {
          throw new TransportError("bad_response", "server response shape is unexpected");
        }
        return parsed as IngestResponse;
      }
      const error = mapStatus(response.status, retryAfter);
      if (!isRetryable(error)) throw error;
      lastError = error;
    } catch (cause) {
      if (cause instanceof TransportError) {
        if (!isRetryable(cause)) throw cause;
        lastError = cause;
        continue;
      }
      if (cause instanceof Error && cause.name === "AbortError") {
        lastError = new TransportError("network", "request timed out");
        continue;
      }
      lastError = new TransportError("network", `request failed: ${(cause as Error).message}`);
    }
  }
  throw lastError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
