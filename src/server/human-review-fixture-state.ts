import { VERSIONED_UUID_PATTERN } from "./api-errors.ts";
import {
  browserFixtureReviewDetail,
  browserFixtureReviewRow
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
};

export type FixtureMutationResult =
  { ok: true } | { ok: false; code: string; message: string };

export async function readFixtureResolvedItems(): Promise<
  Record<string, FixtureResolvedItem>
> {
  const store = await cookieStore();
  return parseResolvedItems(store.get(COOKIE_NAME)?.value);
}

/** Mirrors the production answer: one pending item at its current revision. */
export async function answerFixtureItem(item: {
  inputItemId: string;
  callerId: string;
  actionDisplay: string;
  expectedRevision: number;
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
    return fixtureFailure(
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
  current[item.inputItemId] = {
    actionDisplay: item.actionDisplay.slice(0, 160) || "Answered",
    callerId: item.callerId,
    answeredAt: new Date().toISOString(),
    currentRevision: item.expectedRevision
  };
  writeResolvedItems(store, current);
  return { ok: true };
}

export async function restoreFixtureResolvedItem(inputItemId: string) {
  if (!VERSIONED_UUID_PATTERN.test(inputItemId)) {
    return;
  }
  const store = await cookieStore();
  const current = parseResolvedItems(store.get(COOKIE_NAME)?.value);
  if (!(inputItemId in current)) {
    return;
  }
  const previous = current[inputItemId];
  if (previous.undone) return;
  // Keep the production undo revision across subsequent server renders.
  current[inputItemId] = {
    ...previous,
    currentRevision: (previous.currentRevision ?? 1) + 1,
    undone: true
  };
  writeResolvedItems(store, current);
}

/**
 * The items' rows for a mutation response. The fixture's clock is the number
 * of writes and responses made in this browser's fixture state; like the
 * database clock, it moves on for every response.
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
    (item.undone === undefined || typeof item.undone === "boolean")
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

function writeResolvedItems(
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
