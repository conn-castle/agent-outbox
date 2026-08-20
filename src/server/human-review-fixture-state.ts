const COOKIE_NAME = "agent_outbox_fixture_resolved";
const MAX_RESOLVED_ITEMS = 50;
const MAX_COOKIE_BYTES = 3500;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FixtureResolvedItem = {
  actionDisplay: string;
  callerId: string;
  answeredAt: string;
};

export async function readFixtureResolvedItems(): Promise<
  Record<string, FixtureResolvedItem>
> {
  const store = await cookieStore();
  return parseResolvedItems(store.get(COOKIE_NAME)?.value);
}

export async function recordFixtureResolvedItems(
  items: Array<{
    inputItemId: string;
    callerId: string;
    actionDisplay: string;
  }>
) {
  if (items.length === 0) {
    return;
  }
  const store = await cookieStore();
  const current = parseResolvedItems(store.get(COOKIE_NAME)?.value);
  const answeredAt = new Date().toISOString();
  for (const item of items) {
    if (
      !UUID_PATTERN.test(item.inputItemId) ||
      !UUID_PATTERN.test(item.callerId)
    ) {
      continue;
    }
    current[item.inputItemId] = {
      actionDisplay: item.actionDisplay.slice(0, 160) || "Answered",
      callerId: item.callerId,
      answeredAt
    };
  }
  writeResolvedItems(store, current);
}

export async function forgetFixtureResolvedItem(inputItemId: string) {
  if (!UUID_PATTERN.test(inputItemId)) {
    return;
  }
  const store = await cookieStore();
  const current = parseResolvedItems(store.get(COOKIE_NAME)?.value);
  if (!(inputItemId in current)) {
    return;
  }
  delete current[inputItemId];
  writeResolvedItems(store, current);
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
      if (!UUID_PATTERN.test(inputItemId) || !isResolvedItem(value)) {
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
    UUID_PATTERN.test(item.callerId) &&
    typeof item.answeredAt === "string"
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
  const serialized = fixtureResolvedItemsCookieValue(items);
  if (serialized == null) {
    store.delete(COOKIE_NAME);
    return;
  }
  store.set(COOKIE_NAME, serialized, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24
  });
}
