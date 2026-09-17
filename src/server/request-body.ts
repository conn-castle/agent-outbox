import { Buffer } from "node:buffer";

import { SYSTEM_CONTRACT } from "../shared/system-contract.ts";
import type { ApiErrorInput } from "./api-errors.ts";

export const INPUT_REQUEST_BODY_BYTE_LIMIT =
  SYSTEM_CONTRACT.inputSubmissionBodyBytes;

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
      value: JSON.parse(body.buffer.toString("utf8"))
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
