import type { Request as BrowserRequest, Route } from "@playwright/test";

/** The form a `/human/mutations` request carries. */
export async function mutationForm(request: BrowserRequest) {
  return new Request(request.url(), {
    method: "POST",
    headers: request.headers(),
    body: new Uint8Array(request.postDataBuffer()!)
  }).formData();
}

/** The request's headers and body with its form changed. */
export async function changedForm(
  route: Route,
  change: (form: FormData) => void
) {
  const form = await mutationForm(route.request());
  change(form);
  const encoded = new Request(route.request().url(), {
    method: "POST",
    body: form
  });
  const headers = { ...route.request().headers() };
  delete headers["content-length"];
  return {
    headers: {
      ...headers,
      "content-type": encoded.headers.get("content-type")!
    },
    postData: Buffer.from(await encoded.arrayBuffer())
  };
}

/**
 * Sends a mutation on to the server with its form changed in transit, so the
 * server itself produces the result and item state a real conflict would.
 */
export async function continueWithChangedForm(
  route: Route,
  change: (form: FormData) => void
) {
  await route.continue(await changedForm(route, change));
}

/** Makes the chosen bulk items' revisions stale, so the server rejects them. */
export function continueWithStaleBulkItems(
  route: Route,
  isStale: (index: number) => boolean
) {
  return continueWithChangedForm(route, (form) => {
    const items = form.getAll("bulkItem").map(String);
    form.delete("bulkItem");
    items.forEach((value, index) => {
      const item = JSON.parse(value) as { expectedRevision: number };
      form.append(
        "bulkItem",
        JSON.stringify(
          isStale(index)
            ? { ...item, expectedRevision: item.expectedRevision + 1000 }
            : item
        )
      );
    });
  });
}
