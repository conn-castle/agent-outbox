import {
  apiValidationFailed,
  isJsonRecord,
  type ApiErrorInput,
  type ApiFieldError
} from "./api-errors.ts";
import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";

const PAGE_DEFAULT_LIMIT = SYSTEM_CONTRACT.outputPageDefaultLimit;
const PAGE_MAX_LIMIT = SYSTEM_CONTRACT.outputPageMaxLimit;

export type PageRequest<TCursor> =
  | { ok: true; limit: number; cursor: TCursor | null }
  | { ok: false; error: ApiErrorInput };

export type CursorPayloadDecoder<TCursor> = (
  payload: Record<string, unknown>
) => TCursor | null;

export function invalidPageLimitField(): ApiFieldError {
  return {
    path: "limit",
    code: "invalid_limit",
    message: `limit must be an integer from 1 through ${PAGE_MAX_LIMIT}.`
  };
}

/**
 * Parses keyset page parameters, reporting limit errors before cursor errors
 * under the endpoint's validation message. `decodeCursor` validates the decoded
 * cursor JSON object and returns null when it is not a cursor for this endpoint.
 */
export function parsePageRequest<TCursor>(
  input: { limit: unknown; cursor: unknown },
  decodeCursor: CursorPayloadDecoder<TCursor>,
  validationMessage: string
): PageRequest<TCursor> {
  const limit = parsePageLimit(input.limit);
  const cursor = parsePageCursor(input.cursor, decodeCursor);
  const fields = [
    ...(limit.ok ? [] : [limit.field]),
    ...(cursor.ok ? [] : [cursor.field])
  ];

  if (!limit.ok || !cursor.ok) {
    return apiValidationFailed(validationMessage, fields);
  }

  return { ok: true, limit: limit.value, cursor: cursor.value };
}

export function encodePageCursor(payload: Record<string, string>) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Splits a `limit + 1` row fetch into the returned page and its next cursor. */
export function pageFromRows<TRow>(
  rows: TRow[],
  limit: number,
  cursorForRow: (row: TRow) => string
) {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    page,
    hasMore,
    nextCursor: hasMore ? cursorForRow(page[page.length - 1]) : null
  };
}

function parsePageLimit(value: unknown) {
  if (value == null || value === "") {
    return { ok: true as const, value: PAGE_DEFAULT_LIMIT };
  }

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;

  if (
    !Number.isSafeInteger(numericValue) ||
    numericValue < 1 ||
    numericValue > PAGE_MAX_LIMIT
  ) {
    return { ok: false as const, field: invalidPageLimitField() };
  }

  return { ok: true as const, value: numericValue };
}

function parsePageCursor<TCursor>(
  value: unknown,
  decodeCursor: CursorPayloadDecoder<TCursor>
) {
  if (value == null || value === "") {
    return { ok: true as const, value: null };
  }
  if (typeof value !== "string") {
    return {
      ok: false as const,
      field: {
        path: "cursor",
        code: "invalid_cursor",
        message: "cursor must be an opaque string or null."
      }
    };
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const cursor = isJsonRecord(parsed) ? decodeCursor(parsed) : null;
    if (cursor !== null) {
      return { ok: true as const, value: cursor };
    }
  } catch {
    // Return the safe validation error below.
  }

  return {
    ok: false as const,
    field: {
      path: "cursor",
      code: "invalid_cursor",
      message: "cursor is invalid or expired."
    }
  };
}
