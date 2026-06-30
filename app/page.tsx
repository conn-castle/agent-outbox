import Link from "next/link";

export default function HomePage() {
  return (
    <main className="main">
      <p className="eyebrow">Runtime app shell proof</p>
      <h1 className="title">Agent Outbox</h1>
      <p className="lede">
        A single hosted Next.js and Cloudflare Workers app for human review UI,
        caller API routes, scheduled canaries, database canaries, and correlated
        runtime logs.
      </p>
      <div className="actions">
        <Link className="button" href="/human">
          Open human placeholder
        </Link>
        <Link className="button secondary" href="/api/runtime/canary">
          Runtime canary
        </Link>
      </div>
      <section className="panel" aria-labelledby="phase-boundary">
        <h2 id="phase-boundary">Phase 2 boundary</h2>
        <p>
          This app shell intentionally contains no product queue lifecycle, file
          workflow, billing behavior, cleanup semantics, or Steward-specific
          behavior.
        </p>
      </section>
    </main>
  );
}
