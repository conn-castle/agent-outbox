import Link from "next/link";

import {
  apiDocBySlug,
  apiDocNavigation,
  renderApiDoc,
  type ApiDocSlug
} from "../../server/api-docs";
import { SYSTEM_CONTRACT } from "../../shared/system-contract";
import { ReviewRowAnatomyGallery } from "./ReviewRowAnatomyGallery";

const REVIEW_ROW_ANATOMY_MARKER = "<!-- review-row-anatomy -->";

export function ApiDocsPage({ slug }: { slug: ApiDocSlug }) {
  const document = apiDocBySlug(slug);
  const rendered = renderApiDoc(document);
  const anatomySections = rendered.html.split(REVIEW_ROW_ANATOMY_MARKER);
  const hasAnatomy = anatomySections.length === 2;
  if ((slug === "ui") !== hasAnatomy) {
    throw new Error(
      slug === "ui"
        ? "UI documentation is missing its canonical review-row anatomy marker."
        : `Unexpected review-row anatomy marker in ${slug} documentation.`
    );
  }

  return (
    <main className="api-docs-page">
      <header className="api-docs-hero">
        <div>
          <p className="api-docs-kicker">API documentation</p>
          <h1>{document.title}</h1>
          <p>
            Human guidance and an executable contract for agents that ask, wait,
            and resume.
          </p>
        </div>
        <div className="api-docs-origin" aria-label="Hosted API base URL">
          <span>Hosted API</span>
          <code>{SYSTEM_CONTRACT.hostedAppBaseUrl}/api</code>
        </div>
      </header>

      <div className="api-docs-shell">
        <aside className="api-docs-sidebar" aria-label="API documentation">
          <div>
            <p>Start here</p>
            <nav aria-label="API sections">
              {apiDocNavigation.map((item) => (
                <Link
                  className={item.slug === slug ? "active" : undefined}
                  href={item.href}
                  key={item.slug}
                  aria-current={item.slug === slug ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <a className="api-docs-openapi" href="/docs/api/openapi.json">
            <span>OpenAPI 3.1</span>
            <strong>Download contract</strong>
          </a>
        </aside>

        <article className="api-docs-article">
          <div className="api-docs-sync-note">
            <span aria-hidden="true" />
            Guides + executable contract are verified together
          </div>
          {hasAnatomy ? (
            <>
              <div
                className="api-docs-content"
                // The generated bundle contains only repository-owned canonical Markdown.
                dangerouslySetInnerHTML={{ __html: anatomySections[0] ?? "" }}
              />
              <ReviewRowAnatomyGallery />
              <div
                className="api-docs-content"
                dangerouslySetInnerHTML={{ __html: anatomySections[1] ?? "" }}
              />
            </>
          ) : (
            <div
              className="api-docs-content"
              // The generated bundle contains only repository-owned canonical Markdown.
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          )}
        </article>

        <aside className="api-docs-on-page" aria-label="On this page">
          <p>On this page</p>
          <nav>
            {rendered.headings.map((heading) => (
              <a
                className={heading.depth === 3 ? "nested" : undefined}
                href={`#${heading.id}`}
                key={heading.id}
              >
                {heading.text}
              </a>
            ))}
          </nav>
        </aside>
      </div>
    </main>
  );
}
