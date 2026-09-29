// Canonical public API documentation manifest. Navigation order, labels,
// routes, source files, and relative-link rewriting all derive from this list.
export const API_DOC_PAGES = [
  {
    slug: "quickstart",
    label: "Quick start",
    sourcePath: "docs/spec/public-api.md",
    generated: false
  },
  {
    slug: "concepts",
    label: "How it works",
    sourcePath: "docs/spec/public-api-concepts.md",
    generated: false
  },
  {
    slug: "capabilities",
    label: "Review patterns",
    sourcePath: "docs/spec/public-api-capabilities.md",
    generated: false
  },
  {
    slug: "ui",
    label: "UI integration",
    sourcePath: "docs/spec/public-api-ui.md",
    generated: false
  },
  {
    slug: "reliability",
    label: "Reliability",
    sourcePath: "docs/spec/public-api-reliability.md",
    generated: false
  },
  {
    slug: "reference",
    label: "API reference",
    sourcePath: "docs/spec/public-api-reference.md",
    generated: true
  }
] as const;

export type ApiDocSlug = (typeof API_DOC_PAGES)[number]["slug"];

// Served at the docs root by app/docs/api/page.tsx; every other page is a
// app/docs/api/[section] route named by its slug.
export const API_DOCS_INDEX_SLUG = "quickstart" satisfies ApiDocSlug;

export const OPENAPI_DOCUMENT = {
  href: "/docs/api/openapi.json",
  sourcePath: "docs/openapi.json"
} as const;

const API_DOCS_ROOT_HREF = "/docs/api";

export function apiDocHref(slug: ApiDocSlug) {
  return slug === API_DOCS_INDEX_SLUG
    ? API_DOCS_ROOT_HREF
    : `${API_DOCS_ROOT_HREF}/${slug}`;
}

const hrefBySourcePath = new Map<string, string>([
  ...API_DOC_PAGES.map(
    ({ slug, sourcePath }) => [sourcePath, apiDocHref(slug)] as const
  ),
  [OPENAPI_DOCUMENT.sourcePath, OPENAPI_DOCUMENT.href]
]);

// Resolves a relative Markdown link exactly as a raw Markdown viewer would,
// then maps the repository file it names to its documentation route.
export function apiDocRouteForRelativeLink(sourcePath: string, href: string) {
  const hashIndex = href.indexOf("#");
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const targetPath = decodeURIComponent(
    new URL(path, `file:///${sourcePath}`).pathname.slice(1)
  );
  const route = hrefBySourcePath.get(targetPath);
  if (!route) {
    throw new Error(
      `${sourcePath} links to ${href}, which is not a public API documentation source.`
    );
  }
  return `${route}${hash}`;
}
