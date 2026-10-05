import { Buffer } from "node:buffer";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";
import type { ApiErrorInput } from "./api-errors.ts";
import { MAX_BULK_HUMAN_ANSWER_ITEMS } from "./human-action-form.ts";

export const INPUT_REQUEST_BODY_BYTE_LIMIT =
  SYSTEM_CONTRACT.inputSubmissionBodyBytes;

// Percent encoding expands each UTF-8 byte to at most three wire bytes. Bulk
// feedback has a separate serialized response budget for each of the 100 items.
// Multipart file bytes are unencoded; the accompanying answer still needs room.
// Reserve 1 MiB for UUID/revision records, field names/framing, stored action and
// notice labels, filenames, and ordinary view state. This is a transport safety
// allowance, not a new per-field policy or a bound on arbitrary ignored padding.
export const HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT =
  Math.max(
    3 *
      MAX_BULK_HUMAN_ANSWER_ITEMS *
      SYSTEM_CONTRACT.humanAnswerResponseBodyBytes,
    SYSTEM_CONTRACT.rawFileBytes +
      3 * SYSTEM_CONTRACT.humanAnswerResponseBodyBytes
  ) +
  1024 * 1024;

export type JsonBodyParseResult =
  | { ok: true; bytes: number; value: unknown }
  | { ok: false; error: ApiErrorInput };

export async function readJsonBodyWithLimit(
  request: Request
): Promise<JsonBodyParseResult> {
  const body = await readRawRequestBodyWithLimit(
    request,
    INPUT_REQUEST_BODY_BYTE_LIMIT
  );
  if (!body.ok) {
    return {
      ok: false,
      error: {
        status: 413,
        code: "request_too_large",
        message: `Input request body exceeds the ${INPUT_REQUEST_BODY_BYTE_LIMIT.toLocaleString("en-US")} byte limit.`,
        limit: {
          limit_name: "input_request_body_bytes_excluding_files",
          limit_reason_code: "input_request_too_large",
          limit_reason: "Input request body exceeds the accepted byte ceiling.",
          limit_resets_at: null
        }
      }
    };
  }

  try {
    return {
      ok: true,
      bytes: body.bytes,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          body.buffer
        )
      )
    };
  } catch {
    return {
      ok: false,
      error: {
        status: 400,
        code: "invalid_json",
        message: "Request body must be valid JSON."
      }
    };
  }
}

type RawRequestBodyResult =
  { ok: true; bytes: number; buffer: Buffer } | { ok: false };

export async function readRawRequestBodyWithLimit(
  request: Request,
  byteLimit: number
): Promise<RawRequestBodyResult> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    return { ok: false };
  }

  if (!request.body) {
    return { ok: true, bytes: 0, buffer: Buffer.alloc(0) };
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) {
      return { ok: true, bytes, buffer: Buffer.concat(chunks, bytes) };
    }

    bytes += next.value.byteLength;
    if (bytes > byteLimit) {
      await reader.cancel();
      return { ok: false };
    }

    chunks.push(Buffer.from(next.value));
  }
}

export type FormDataBodyParseResult =
  | { ok: true; formData: FormData }
  | { ok: false; reason: "too_large" | "invalid" };

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds byte limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

type BoundedRequestBody =
  | { ok: false }
  | {
      ok: true;
      body: ReadableStream<Uint8Array> | null;
      failure: () => {
        reason: "too_large" | "unexpected";
        error: unknown;
      } | null;
    };

/** Count forwarded bytes without buffering or copying the whole request. */
export function boundedRequestBody(
  request: Request,
  byteLimit: number
): BoundedRequestBody {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    return { ok: false };
  }

  const source = request.body?.getReader();
  let bytes = 0;
  let failure: { reason: "too_large" | "unexpected"; error: unknown } | null =
    null;
  const body = source
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await source.read();
          } catch (error) {
            failure = { reason: "unexpected", error };
            controller.error(error);
            return;
          }
          if (next.done) {
            controller.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > byteLimit) {
            failure = {
              reason: "too_large",
              error: new RequestBodyTooLargeError()
            };
            try {
              await source.cancel(failure.error);
            } catch (error) {
              failure = { reason: "unexpected", error };
            }
            controller.error(failure.error);
            return;
          }
          controller.enqueue(next.value);
        },
        cancel(reason) {
          return source.cancel(reason);
        }
      })
    : null;

  return { ok: true, body, failure: () => failure };
}

/**
 * Parses a multipart or URL-encoded body while counting streamed bytes, so an
 * oversized body is rejected before it is fully buffered. Errors from reading
 * the request stream itself are rethrown rather than reported as invalid.
 */
export async function readFormDataWithLimit(
  request: Request,
  byteLimit: number
): Promise<FormDataBodyParseResult> {
  const bounded = boundedRequestBody(request, byteLimit);
  if (!bounded.ok) {
    return { ok: false, reason: "too_large" };
  }

  const contentType = request.headers.get("content-type");
  try {
    const formData = await new Response(bounded.body, {
      headers: contentType ? { "content-type": contentType } : {}
    }).formData();
    return { ok: true, formData };
  } catch (error) {
    const failure = bounded.failure();
    if (failure?.reason === "too_large") {
      return { ok: false, reason: "too_large" };
    }
    if (failure) throw failure.error;
    if (isMalformedFormDataError(error))
      return { ok: false, reason: "invalid" };
    throw error;
  }
}

// These are explicit form-validation errors from Node/Next's Undici parser and
// workerd's native parser. Other TypeErrors (including body/stream misuse) and
// unknown parser failures must reach the route's reported 503 path. Source-read
// errors are rethrown first, even when their message matches a parser error.
function isMalformedFormDataError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  return (
    [
      "Failed to parse body as FormData.",
      'Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".',
      "Parsing a Body as FormData requires a Content-Type header.",
      "Unrecognized Content-Type header value. FormData can only parse the following MIME types: multipart/form-data, application/x-www-form-urlencoded",
      "Invalid Content-Disposition header found in FormData part.",
      "No valid Content-Disposition header found in FormData part.",
      "FormData part had invalid headers.",
      "Content-Disposition header in FormData part is missing a name.",
      "No initial boundary string (or you have a truncated message).",
      "No subsequent boundary string after multipart message.",
      "No multipart message header termination found.",
      "Length of multipart/form-data boundary string must be in the range [1, 70].",
      "No boundary string in Content-Type header. The multipart/form-data MIME type requires a boundary parameter, e.g. 'Content-Type: multipart/form-data; boundary=\"abcd\"'. See RFC 7578, section 4."
    ].includes(error.message) ||
    (error.message.startsWith(
      'Content-Disposition header for FormData part must have the value "form-data", possibly followed by parameters. Got: "'
    ) &&
      error.message.endsWith('"'))
  );
}
