import { Buffer } from "node:buffer";

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
