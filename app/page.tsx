import Link from "next/link";

export default function HomePage() {
  return (
    <main className="main">
      <p className="eyebrow">Runtime app shell</p>
      <h1 className="title">Agent Outbox</h1>
      <p className="lede">
        A single hosted Next.js and Cloudflare Workers app for a protected human
        review surface, caller API routes, scheduled canaries, database
        canaries, and correlated runtime logs.
      </p>
      <div className="actions">
        <Link className="button" href="/human">
          Open review queue
        </Link>
        <Link className="button secondary" href="/api/runtime/canary">
          Runtime canary
        </Link>
      </div>
      <section className="panel" aria-labelledby="current-surface">
        <h2 id="current-surface">Current app surface</h2>
        <p>
          This repository currently includes caller-authenticated status, input,
          output, acknowledgement, and output-file download routes plus a
          protected human review queue UI. Caller registration, billing, paid
          file-upload workflows, and Steward-specific integrations are scheduled
          for later phases.
        </p>
      </section>
    </main>
  );
}
