import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

const viewports = [
  {
    key: "desktop",
    label: "Desktop",
    dimensions: "1440 × 900",
    width: 1440,
    height: 900
  },
  {
    key: "tablet",
    label: "Tablet",
    dimensions: "834 × 1112",
    width: 834,
    height: 1112
  },
  {
    key: "phone",
    label: "Phone",
    dimensions: "390 × 844",
    width: 390,
    height: 844
  }
] as const;

export function StoryboardHeader({
  label,
  previewHref
}: {
  label: string;
  previewHref?: string;
}) {
  return (
    <header className="storyboard-header">
      <div className="storyboard-brand product-wordmark">
        <img src="/agent-outbox-mark.svg" alt="" width="34" height="34" />
        <span>
          Agent <b>Outbox</b>
        </span>
        <i>{label}</i>
      </div>
      <div className="storyboard-header-actions">
        <Link href="/human">
          <ArrowLeft aria-hidden="true" /> Back to queue
        </Link>
        {previewHref ? (
          <a href={previewHref} target="_blank" rel="noreferrer">
            Open live viewport <ExternalLink aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </header>
  );
}

// Renders one selected scenario of a fixture storyboard: the scenario index,
// the stage header, and the same preview URL framed at each exact viewport
// width. The eyebrow names the scenario in each frame's accessible title.
export function StoryboardShell({
  label,
  previewHref,
  indexLabel,
  countLabel,
  intro,
  scenarios,
  eyebrow,
  title,
  subtitle,
  modeNav,
  coverage
}: {
  label: string;
  previewHref: string;
  indexLabel: string;
  countLabel: string;
  intro: string;
  scenarios: readonly {
    key: string;
    href: string;
    label: string;
    selected: boolean;
  }[];
  eyebrow: string;
  title: string;
  subtitle: string;
  modeNav?: ReactNode;
  coverage: readonly string[];
}) {
  return (
    <main className="review-storyboard">
      <StoryboardHeader label={label} previewHref={previewHref} />

      <div className="storyboard-layout">
        <nav className="storyboard-index" aria-label={indexLabel}>
          <div className="storyboard-index-intro">
            <span>Coverage catalog</span>
            <strong>{countLabel}</strong>
            <p>{intro}</p>
          </div>
          <ol>
            {scenarios.map((scenario, index) => (
              <li key={scenario.key}>
                <Link
                  className={scenario.selected ? "selected" : undefined}
                  href={scenario.href}
                  aria-current={scenario.selected ? "page" : undefined}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{scenario.label}</strong>
                </Link>
              </li>
            ))}
          </ol>
        </nav>

        <section className="storyboard-stage" aria-labelledby="story-title">
          <div className="storyboard-stage-header">
            <div>
              <p>{eyebrow}</p>
              <h1 id="story-title">{title}</h1>
              <span>{subtitle}</span>
            </div>
            {modeNav}
          </div>

          <div className="storyboard-meta-row">
            <div className="storyboard-coverage" aria-label="Covered states">
              {coverage.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <nav className="storyboard-width-nav" aria-label="Jump to width">
              {viewports.map((viewport) => (
                <a href={`#viewport-${viewport.key}`} key={viewport.key}>
                  {viewport.label} <span>{viewport.width}</span>
                </a>
              ))}
            </nav>
          </div>

          <div className="storyboard-frames" aria-label="Responsive previews">
            {viewports.map((viewport) => (
              <article
                className="storyboard-frame"
                key={viewport.key}
                id={`viewport-${viewport.key}`}
              >
                <header>
                  <div>
                    <span>{viewport.label}</span>
                    <small>{viewport.dimensions} · exact CSS pixels</small>
                  </div>
                  <a href={previewHref} target="_blank" rel="noreferrer">
                    Open separately <ExternalLink aria-hidden="true" />
                  </a>
                </header>
                <div className="storyboard-viewport">
                  <iframe
                    src={previewHref}
                    title={`${eyebrow} at ${viewport.label} width`}
                    width={viewport.width}
                    height={viewport.height}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
