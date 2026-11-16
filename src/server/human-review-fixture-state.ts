import { VERSIONED_UUID_PATTERN } from "./api-errors.ts";
import {
  browserFixtureReviewDetail,
  browserFixtureReviewRow,
  fixtureResolvedOutputResultId
} from "./human-review-fixture.ts";
import type { HumanMutationState } from "../shared/human-mutation.ts";

const COOKIE_NAME = "agent_outbox_fixture_resolved";
const VERSION_COOKIE_NAME = "agent_outbox_fixture_version";
const MAX_RESOLVED_ITEMS = 50;
const MAX_COOKIE_BYTES = 3500;
const FIXTURE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24
} as const;

export type FixtureResolvedItem = {
  actionDisplay: string;
  callerId: string;
  answeredAt: string;
  currentRevision?: number;
  undone?: boolean;
  // The request that answered the item, so its retry is recognized.
  mutationId?: string;
};

export type FixtureMutationResult =
  { ok: true } | { ok: false; code: string; message: string };

export async function readFixtureResolvedItems(): Promise<
  Record<string, FixtureResolvedItem>
> {
  const store = await cookieStore();
  return parseResolvedItems(store.get(COOKIE_NAME)?.value);
}

/**
 * The fixture's position on its own clock: the number of writes made to this
 * browser's fixture state. A page rendered from an older cookie reports an
 * older value, exactly as a database page read before a commit would.
 */
export async function readFixtureAsOf() {
  return String(parseVersion((await cookieStore()).get(VERSION_COOKIE_NAME)));
}

/** Mirrors the production answer: one pending item at its current revision. */
export async function answerFixtureItem(item: {
  inputItemId: string;
  callerId: string;
  actionDisplay: string;
  expectedRevision: number;
  mutationId: string;
}): Promise<FixtureMutationResult> {
  const store = await cookieStore();
  const current = parseResolvedItems(store.get(COOKIE_NAME)?.value);
  const canonical = browserFixtureReviewDetail(item.inputItemId, {
    resolvedItems: current
  });
  if (!canonical || canonical.inputItemId !== item.inputItemId) {
    return fixtureFailure("not_found", "Input item was not found.");
  }
  if (canonical.status !== "pending") {
    const previous = current[item.inputItemId];
    // A retry of an answer that already committed reports that answer.
    return previous &&
      !previous.undone &&
      previous.mutationId === item.mutationId
      ? { ok: true }
      : fixtureFailure(
          "input_not_pending",
          "Human answer creation requires a pending input item."
        );
  }
  if (canonical.currentRevision !== item.expectedRevision) {
    return fixtureFailure(
      "stale_input_revision",
      "Input item revision changed before the answer was submitted."
    );
  }
  if (
    !VERSIONED_UUID_PATTERN.test(item.inputItemId) ||
    !VERSIONED_UUID_PATTERN.test(item.callerId)
  ) {
    return fixtureFailure("invalid_request", "Action failed: invalid request.");
  }
  // Re-insert so the newest answer is the last one trimmed from the cookie.
  delete current[item.inputItemId];
  current[item.inputItemId] = {
    actionDisplay: item.actionDisplay.slice(0, 160) || "Answered",
    callerId: item.callerId,
    answeredAt: new Date().toISOString(),
    currentRevision: item.expectedRevision,
    mutationId: item.mutationId
  };
  writeFixtureState(store, current);
  return { ok: true };
}

/** Mirrors the production pre-read undo, including a repeated request. */
export async function undoFixtureAnswer(target: {
  inputItemId: string;
  callerId: string;
  outputResultId: string;
}): Promise<FixtureMutationResult> {
  const { inputItemId } = target;
  const store = await cookieStore();
  const current = parseResolvedItems(store.get(COOKIE_NAME)?.value);
  const previous = current[inputItemId];
  if (previous?.undone) {
    // A repeat is recognized only for the output this undo removed, which was
    // answered one revision before the restored item's current one.
    return previous.callerId === target.callerId &&
      previous.currentRevision !== undefined &&
      fixtureResolvedOutputResultId(
        inputItemId,
        previous.currentRevision - 1
      ) === target.outputResultId
      ? { ok: true }
      : fixtureFailure("not_found", "Output result was not found.");
  }
  const canonical = browserFixtureReviewDetail(inputItemId, {
    resolvedItems: current
  });
  if (
    !canonical ||
    canonical.inputItemId !== inputItemId ||
    canonical.status !== "answered" ||
    canonical.caller.callerId !== target.callerId ||
    canonical.output?.outputResultId !== target.outputResultId
  ) {
    return fixtureFailure("not_found", "Output result was not found.");
  }
  if (!canonical.output.undoEligible) {
    return fixtureFailure(
      "output_already_read",
      "Output result has already been read by the caller."
    );
  }
  // Keep the production undo revision across subsequent server renders.
  current[inputItemId] = {
    actionDisplay: canonical.output.actionDisplay,
    callerId: canonical.caller.callerId,
    answeredAt: canonical.output.answeredAt,
    currentRevision: canonical.currentRevision + 1,
    undone: true
  };
  writeFixtureState(store, current);
  return { ok: true };
}

/**
 * The items' rows for a mutation response. Like the database clock, the
 * fixture clock moves on for every response, so even a rejection's state is
 * newer than the page the person acted on.
 */
export async function readFixtureItemStates(
  inputItemIds: string[]
): Promise<HumanMutationState> {
  const store = await cookieStore();
  const resolvedItems = parseResolvedItems(store.get(COOKIE_NAME)?.value);
  const asOf = parseVersion(store.get(VERSION_COOKIE_NAME)) + 1;
  store.set(VERSION_COOKIE_NAME, String(asOf), FIXTURE_COOKIE_OPTIONS);
  return {
    asOf: String(asOf),
    items: inputItemIds.map((inputItemId) => ({
      inputItemId,
      row: browserFixtureReviewRow(inputItemId, { resolvedItems })
    }))
  };
}

function fixtureFailure(code: string, message: string) {
  return { ok: false as const, code, message };
}

function parseVersion(cookie: { value: string } | undefined) {
  const version = Number(cookie?.value);
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

function parseResolvedItems(
  raw: string | undefined
): Record<string, FixtureResolvedItem> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const items: Record<string, FixtureResolvedItem> = {};
    for (const [inputItemId, value] of Object.entries(parsed)) {
      if (!VERSIONED_UUID_PATTERN.test(inputItemId) || !isResolvedItem(value)) {
        continue;
      }
      items[inputItemId] = value;
      if (Object.keys(items).length >= MAX_RESOLVED_ITEMS) {
        break;
      }
    }
    return items;
  } catch {
    return {};
  }
}

function isResolvedItem(value: unknown): value is FixtureResolvedItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.actionDisplay === "string" &&
    item.actionDisplay.length > 0 &&
    typeof item.callerId === "string" &&
    VERSIONED_UUID_PATTERN.test(item.callerId) &&
    typeof item.answeredAt === "string" &&
    (item.currentRevision === undefined ||
      (Number.isSafeInteger(item.currentRevision) &&
        Number(item.currentRevision) > 0)) &&
    (item.undone === undefined || typeof item.undone === "boolean") &&
    (item.mutationId === undefined ||
      (typeof item.mutationId === "string" &&
        VERSIONED_UUID_PATTERN.test(item.mutationId)))
  );
}

export function fixtureResolvedItemsCookieValue(
  items: Record<string, FixtureResolvedItem>
): string | null {
  const ids = Object.keys(items);
  if (ids.length === 0) {
    return null;
  }
  let retained = ids.slice(-MAX_RESOLVED_ITEMS);
  let serialized = JSON.stringify(
    Object.fromEntries(retained.map((id) => [id, items[id]]))
  );
  while (
    retained.length > 1 &&
    Buffer.byteLength(serialized, "utf8") > MAX_COOKIE_BYTES
  ) {
    retained = retained.slice(1);
    serialized = JSON.stringify(
      Object.fromEntries(retained.map((id) => [id, items[id]]))
    );
  }
  return serialized;
}

async function cookieStore() {
  const { cookies } = await import("next/headers");
  return cookies();
}

function writeFixtureState(
  store: Awaited<ReturnType<typeof cookieStore>>,
  items: Record<string, FixtureResolvedItem>
) {
  store.set(
    VERSION_COOKIE_NAME,
    String(parseVersion(store.get(VERSION_COOKIE_NAME)) + 1),
    FIXTURE_COOKIE_OPTIONS
  );
  const serialized = fixtureResolvedItemsCookieValue(items);
  if (serialized == null) {
    store.delete(COOKIE_NAME);
    return;
  }
  store.set(COOKIE_NAME, serialized, FIXTURE_COOKIE_OPTIONS);
}
