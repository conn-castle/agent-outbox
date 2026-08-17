import { Marked, Renderer, type Token, type Tokens } from "marked";

import generatedApiDocs from "../shared/api-docs.generated.json";

export const apiDocNavigation = [
  { slug: "quickstart", label: "Quick start", href: "/docs/api" },
  { slug: "concepts", label: "How it works", href: "/docs/api/concepts" },
  {
    slug: "capabilities",
    label: "Review patterns",
    href: "/docs/api/capabilities"
  },
  {
    slug: "ui",
    label: "UI integration",
    href: "/docs/api/ui"
  },
  {
    slug: "reliability",
    label: "Reliability",
    href: "/docs/api/reliability"
  },
  { slug: "reference", label: "API reference", href: "/docs/api/reference" }
] as const;

export type ApiDocSlug = (typeof apiDocNavigation)[number]["slug"];

export type ApiDoc = {
  slug: ApiDocSlug;
  sourcePath: string;
  source: string;
  title: string;
};

export type ApiDocHeading = {
  depth: 2 | 3;
  id: string;
  text: string;
};

const routeBySourceName: Record<string, string> = {
  "public-api.md": "/docs/api",
  "public-api-concepts.md": "/docs/api/concepts",
  "public-api-capabilities.md": "/docs/api/capabilities",
  "public-api-ui.md": "/docs/api/ui",
  "public-api-reliability.md": "/docs/api/reliability",
  "public-api-reference.md": "/docs/api/reference",
  "openapi.json": "/docs/api/openapi.json"
};

const documents = generatedApiDocs.documents.map((document) => {
  if (!isApiDocSlug(document.slug)) {
    throw new Error(
      `Unknown generated API documentation slug: ${document.slug}`
    );
  }
  const title = firstHeading(document.source);
  if (!title) {
    throw new Error(
      `Generated API documentation has no title: ${document.sourcePath}`
    );
  }
  return { ...document, slug: document.slug, title } satisfies ApiDoc;
});

for (const item of apiDocNavigation) {
  if (!documents.some((document) => document.slug === item.slug)) {
    throw new Error(`Generated API documentation is missing: ${item.slug}`);
  }
}

export function isApiDocSlug(value: string): value is ApiDocSlug {
  return apiDocNavigation.some((item) => item.slug === value);
}

export function apiDocBySlug(slug: ApiDocSlug): ApiDoc {
  const document = documents.find((candidate) => candidate.slug === slug);
  if (!document) {
    throw new Error(`Generated API documentation is missing: ${slug}`);
  }
  return document;
}

export function renderApiDoc(document: ApiDoc) {
  const markdown = document.source.replace(/^#\s+[^\n]+\n+/, "");
  const slugger = createSlugger();
  const renderer = new Renderer();

  renderer.heading = function heading({ tokens, depth }: Tokens.Heading) {
    const text = this.parser.parseInline(tokens);
    const id = slugger.slug(plainTokenText(tokens));
    return `<h${depth} id="${escapeAttribute(id)}">${text}<a class="api-docs-heading-link" href="#${escapeAttribute(id)}" aria-label="Link to ${escapeAttribute(plainTokenText(tokens))}">#</a></h${depth}>\n`;
  };

  renderer.link = function link({ href, title, tokens }: Tokens.Link) {
    const rewrittenHref = rewriteDocumentationHref(href);
    const renderedText = this.parser.parseInline(tokens);
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
    const relAttribute = /^https?:\/\//.test(rewrittenHref)
      ? ' rel="noreferrer"'
      : "";
    return `<a href="${escapeAttribute(rewrittenHref)}"${titleAttribute}${relAttribute}>${renderedText}</a>`;
  };

  const marked = new Marked({
    gfm: true,
    renderer
  });
  const html = marked.parse(markdown, { async: false });

  return {
    html,
    headings: extractHeadings(markdown)
  };
}

function extractHeadings(markdown: string): ApiDocHeading[] {
  const slugger = createSlugger();
  const headings: ApiDocHeading[] = [];
  for (const match of markdown.matchAll(/^(#{2,3})\s+(.+)$/gm)) {
    const depth = match[1]?.length;
    const text = match[2]?.replaceAll("`", "").trim();
    if ((depth === 2 || depth === 3) && text) {
      headings.push({ depth, text, id: slugger.slug(text) });
    }
  }
  return headings;
}

function rewriteDocumentationHref(href: string) {
  if (href.startsWith("#") || /^(https?:|mailto:)/.test(href)) {
    return href;
  }
  const hashIndex = href.indexOf("#");
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
  const sourceName = path.split("/").at(-1) ?? path;
  const route = routeBySourceName[sourceName];
  if (route) return `${route}${hash}`;
  throw new Error(`Unknown relative link in public API documentation: ${href}`);
}

function firstHeading(source: string) {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function plainTokenText(tokens: Token[]) {
  return tokens
    .map((token) => {
      if ("text" in token && typeof token.text === "string") return token.text;
      return token.raw;
    })
    .join("")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function createSlugger() {
  const counts = new Map<string, number>();
  return {
    slug(value: string) {
      const base =
        value
          .toLowerCase()
          .replace(/&[a-z]+;/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "section";
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      return count === 0 ? base : `${base}-${count + 1}`;
    }
  };
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
