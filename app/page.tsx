import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";

const handoffSteps = [
  {
    number: "01",
    title: "The agent reaches a decision point.",
    copy: "It sends a structured request with the relevant context and response options already attached."
  },
  {
    number: "02",
    title: "The review stays organized until you are ready.",
    copy: "Agent Outbox keeps every request visible for the right reviewer, without adding another meeting or live handoff."
  },
  {
    number: "03",
    title: "Your response becomes the next instruction.",
    copy: "The agent receives one explicit response, acknowledges it, and continues from the same point in its workflow."
  }
];

const reviewDetails = [
  "Agent identity, priority, and revision stay visible",
  "Approval, choice, text, date, and file responses",
  "Responses can be undone until agent acknowledgement"
];

const useCases = [
  {
    number: "01",
    label: "Before it sends",
    title: "Approve agent-drafted email.",
    copy: "Let an agent prepare the reply and gather the context. Keep final review in human hands before it reaches a customer, partner, or teammate."
  },
  {
    number: "02",
    label: "Before it commits",
    title: "Confirm a high-impact decision.",
    copy: "Send purchases, policy exceptions, and production changes to the accountable person before action is taken."
  },
  {
    number: "03",
    label: "When a run hits ambiguity",
    title: "Answer without watching the run.",
    copy: "Let an overnight research or data agent pause on a missing assumption, ask the right person, and resume after the answer arrives."
  },
  {
    number: "04",
    label: "When an automated check fails",
    title: "Resolve the exception asynchronously.",
    copy: "Route a failed deployment check, unmatched record, or policy exception to an owner, then let the workflow continue from their response."
  }
];

const freePlanDetails = [
  "5,000 review requests each month",
  "Up to 1,000 pending requests",
  "60-day window for pending requests",
  "32 MB review data storage"
];

const paidPlanDetails = [
  "No monthly submission or queue caps",
  "Pending requests stay until resolved",
  "File uploads in requests and responses",
  "1 GB total account storage"
];

export default function HomePage() {
  return (
    <main className="landing">
      <section className="landing-hero">
        <p className="landing-kicker">
          <span /> Human decisions for autonomous work <span />
        </p>
        <h1>
          Where agents wait for <br />
          <em>your decision.</em>
        </h1>
        <p className="landing-hero-copy">
          Agent Outbox is an asynchronous review queue for automated agents.
          Callers submit questions or approval requests, then retrieve your
          response when their workflow is ready to continue.
        </p>
        <div className="landing-actions">
          <Link className="button" href="/sign-up">
            Get started free <ArrowRight aria-hidden="true" />
          </Link>
          <Link className="landing-text-link" href="#product">
            Explore the product <span aria-hidden="true">↓</span>
          </Link>
        </div>
      </section>

      <section
        className="landing-product"
        id="product"
        aria-label="Product preview"
      >
        <div className="landing-product-meta" aria-hidden="true">
          <p>Agent Outbox / Review queue</p>
          <p>Actual product interface</p>
        </div>
        <div className="landing-browser-frame">
          <div className="landing-browser-bar" aria-hidden="true">
            <div>
              <span />
              <span />
              <span />
            </div>
            <p>app.agent-outbox.dev/human</p>
            <span>•••</span>
          </div>
          <picture>
            <source
              media="(max-width: 720px)"
              srcSet="/product-review-mobile.png"
              width="430"
              height="932"
            />
            <img
              src="/product-review-queue.png"
              alt="Agent Outbox review queue with pending requests and an open neighborhood permit review"
              width="1440"
              height="960"
            />
          </picture>
        </div>
        <div className="landing-product-footnote">
          <p>
            <b>One inbox.</b> Every agent decision that needs your review.
          </p>
          <p>Search · filter · review · respond</p>
        </div>
      </section>

      <section className="landing-connect" id="installation">
        <div className="landing-connect-heading">
          <p className="landing-index">01 / Installation</p>
          <h2>Connect once. Then step away.</h2>
          <p className="landing-install-note">
            Install the CLI and connect an agent to your account. It can send a
            review request whenever human input is required—even when nobody is
            watching the run.
          </p>
        </div>
        <div className="landing-connect-body">
          <div className="landing-install-panel">
            <ol
              className="landing-install-steps"
              aria-label="Installation steps"
            >
              <li>
                <span>01</span>
                <p>Install with Homebrew</p>
              </li>
              <li>
                <span>02</span>
                <p>Connect your agent</p>
              </li>
              <li>
                <span>03</span>
                <p>Approve in browser</p>
              </li>
            </ol>
            <div
              className="landing-terminal"
              aria-label="Agent Outbox installation commands"
            >
              <div className="landing-terminal-bar">
                <span>agent-outbox / zsh</span>
                <span>Homebrew</span>
              </div>
              <pre>
                <code>
                  <span>$</span>
                  {" brew install --cask conn-castle/tap/agent-outbox\n"}
                  <span>$</span> agent-outbox caller connect my-agent
                </code>
              </pre>
            </div>
            <p className="landing-terminal-help">
              <code>my-agent</code> is a local label you choose. The connect
              command opens Agent Outbox so you can review and approve the
              caller in your browser.
            </p>
          </div>
        </div>
      </section>

      <section className="landing-thesis" id="how-it-works">
        <div className="landing-thesis-heading">
          <p className="landing-index">02 / The handoff</p>
          <h2>
            Agents should ask.
            <br />
            Not guess.
          </h2>
        </div>
        <div className="landing-thesis-copy landing-section-deck">
          <p>
            Some steps require human judgment. Agent Outbox makes that handoff a
            deliberate, reliable part of the workflow, even when the reviewer
            and agent are working at different times.
          </p>
        </div>
        <div className="landing-handoff-list">
          {handoffSteps.map((step) => (
            <article key={step.number}>
              <p>{step.number}</p>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-review-story">
        <div className="landing-review-copy">
          <p className="landing-index">03 / The decision</p>
          <h2>See what the agent needs from you.</h2>
          <p>
            Each request brings the prompt, supporting material, and available
            responses into one place. Review the context, respond, and return to
            your work.
          </p>
          <ul>
            {reviewDetails.map((detail) => (
              <li key={detail}>
                <Check aria-hidden="true" /> {detail}
              </li>
            ))}
          </ul>
        </div>
        <figure className="landing-detail-figure">
          <div className="landing-tablet-frame">
            <span className="landing-tablet-camera" aria-hidden="true" />
            <div className="landing-tablet-screen">
              <img
                src="/product-review-ipad.png"
                alt="Agent Outbox request detail with structured context and response actions"
                width="768"
                height="1024"
              />
            </div>
          </div>
        </figure>
      </section>

      <section className="landing-use-cases" id="use-cases">
        <header>
          <p className="landing-index">04 / Use cases</p>
          <h2>Put human judgment exactly where it adds value.</h2>
          <p className="landing-section-deck">
            Use one review queue for approvals, edits, questions, and
            operational decisions across your agent workflows.
          </p>
        </header>
        <div className="landing-use-case-list">
          {useCases.map((useCase) => (
            <article key={useCase.number}>
              <p className="landing-use-case-number">{useCase.number}</p>
              <div>
                <p className="landing-use-case-label">{useCase.label}</p>
                <h3>{useCase.title}</h3>
              </div>
              <p className="landing-use-case-copy">{useCase.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-mobile-story">
        <div className="landing-mobile-stage">
          <div className="landing-orbit orbit-one" aria-hidden="true" />
          <div className="landing-orbit orbit-two" aria-hidden="true" />
          <div className="landing-phone-frame">
            <div className="landing-phone-speaker" aria-hidden="true" />
            <img
              src="/product-review-mobile.png"
              alt="Agent Outbox review queue on a mobile screen"
              width="430"
              height="932"
            />
          </div>
        </div>
        <div className="landing-mobile-copy">
          <p className="landing-index">05 / Wherever you are</p>
          <h2>Review from any screen.</h2>
          <p>
            Review one request between meetings or work through the full queue
            at your desk. The responsive interface keeps the prompt, context,
            and actions in view.
          </p>
          <p className="landing-proof-label">
            Actual responsive product · 430px viewport
          </p>
        </div>
      </section>

      <section className="landing-pricing" id="pricing">
        <header>
          <p className="landing-index">06 / Pricing</p>
          <h2>
            Start free.
            <br />
            Scale with Pro.
          </h2>
          <p className="landing-section-deck">
            Build and run complete review workflows on the free plan. Choose Pro
            for higher volume, longer-lived pending requests, file uploads, and
            expanded storage.
          </p>
        </header>
        <div className="landing-pricing-ledger">
          <article className="landing-plan landing-plan-free">
            <div className="landing-plan-heading">
              <p>Starter</p>
              <p className="landing-plan-price">
                <strong>$0</strong>
                <span>per month</span>
              </p>
              <p>Complete review workflows for everyday volume.</p>
            </div>
            <ul>
              {freePlanDetails.map((detail) => (
                <li key={detail}>
                  <Check aria-hidden="true" /> {detail}
                </li>
              ))}
            </ul>
            <Link
              className="landing-plan-link landing-plan-link-secondary"
              href="/sign-up"
            >
              Start for free <ArrowRight aria-hidden="true" />
            </Link>
          </article>
          <article className="landing-plan landing-plan-paid">
            <div className="landing-plan-heading">
              <p>Pro</p>
              <p className="landing-plan-price">
                <strong>$5</strong>
                <span>per month · $50 per year</span>
              </p>
              <p>Higher-volume workflows with files and more storage.</p>
            </div>
            <ul>
              {paidPlanDetails.map((detail) => (
                <li key={detail}>
                  <Check aria-hidden="true" /> {detail}
                </li>
              ))}
            </ul>
            <Link
              className="landing-plan-link landing-plan-link-primary"
              href="/upgrade"
            >
              Start with Pro <ArrowRight aria-hidden="true" />
            </Link>
          </article>
        </div>
        <p className="landing-pricing-note">
          Plans apply per account. Both include the complete review queue,
          search, status controls, and every non-file response type. Standard
          request-size and rate protections apply.
        </p>
      </section>

      <section className="landing-final-cta">
        <p className="landing-kicker">
          <span /> Ready when you are <span />
        </p>
        <h2>
          Keep agents moving.
          <br />
          Review when it works for you.
        </h2>
        <Link className="button" href="/sign-up">
          Create your free account <ArrowRight aria-hidden="true" />
        </Link>
        <p>Free to start · No credit card required</p>
      </section>
    </main>
  );
}
