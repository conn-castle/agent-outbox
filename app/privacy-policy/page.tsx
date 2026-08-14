import type { Metadata } from "next";

import {
  CompanyAddress,
  LegalSection
} from "../../src/components/legal/LegalDocument";

export const metadata: Metadata = {
  title: "Privacy Policy | Agent Outbox",
  description:
    "How Agent Outbox collects, uses, discloses, retains, and protects information."
};

export default function PrivacyPolicyPage() {
  return (
    <main className="legal-main">
      <header className="legal-header">
        <p className="eyebrow">Legal</p>
        <h1 className="legal-title">Privacy Policy</h1>
        <p className="legal-summary">
          This Policy explains what information Conn Castle Studios collects
          through Agent Outbox, why we use it, when we disclose it, how long
          primary service content remains available, and the choices available
          to you.
        </p>
        <p className="legal-updated">Last updated: August 13, 2026</p>
      </header>
      <article className="legal-content">
        <section className="legal-section">
          <p>
            This Privacy Policy applies to the Agent Outbox website, sign-up and
            sign-in flows, hosted application, caller API, command-line
            software, billing flows, and support interactions (collectively, the
            &quot;Services&quot;).
          </p>
          <p>
            &quot;Conn Castle Studios,&quot; &quot;we,&quot; &quot;us,&quot; and
            &quot;our&quot; refer to Hardware Breakout LLC doing business as
            Conn Castle Studios. &quot;You&quot; refers to the person or entity
            using the Services.
          </p>
          <p>
            The Services are controlled from the United States and intended for
            the U.S. market. We do not market or localize the Services for the
            European Union, European Economic Area, United Kingdom, or
            Switzerland. If you access the Services from another location, your
            information may be processed in the United States and in locations
            where our providers operate.
          </p>
        </section>

        <LegalSection number={1} title="Information We Collect">
          <h3>Account and billing information</h3>
          <ul>
            <li>
              Authentication information such as your email address and the user
              and session identifiers managed through Clerk.
            </li>
            <li>
              Agent Outbox account identifiers, membership, account tier, and
              account activity timestamps.
            </li>
            <li>
              Stripe customer, subscription, price, status, period, and webhook
              identifiers used to administer paid plans. Stripe, not Agent
              Outbox, collects and processes full payment-card details.
            </li>
          </ul>

          <h3>Caller registration and credential information</h3>
          <ul>
            <li>
              Caller names, caller slugs, setup-request state, approval state,
              callback information, and timestamps used to connect, rotate, and
              revoke callers.
            </li>
            <li>
              Caller key identifiers, prefixes, last characters, keyed secret
              digests, status, activation, use, expiration, and revocation
              timestamps. Display-once caller secrets are not retained in
              plaintext by the hosted service.
            </li>
          </ul>

          <h3>Review queue, answer, and file content</h3>
          <ul>
            <li>
              Review-item identifiers, titles, subtitles, summaries, details,
              safe HTML, links, icons, priorities, visual metadata, available
              actions, popup fields, caller-owned values, and timestamps
              submitted by authorized callers.
            </li>
            <li>
              Human answers such as action choices, free text, selections,
              dates, and file-upload responses, together with read and
              acknowledgement state.
            </li>
            <li>
              Uploaded filenames, MIME types, byte sizes, cryptographic digests,
              and file bytes. Uploaded files are part of a caller result, not a
              general-purpose file-storage service.
            </li>
          </ul>

          <h3>Usage, security, and diagnostic information</h3>
          <ul>
            <li>
              Request timestamps, routes, response status, trusted source IP
              information used for narrow abuse controls, quota windows, rate
              limits, storage counts, and active limit state.
            </li>
            <li>
              Content-safe audit events containing lifecycle event types,
              internal identifiers, response kinds, byte counts, deletion
              reasons, and request or correlation identifiers. Audit events are
              designed not to contain review text, answer text, file bytes, or
              caller secrets.
            </li>
            <li>
              Content-safe application logs and Sentry error reports containing
              error class, operation, route, release, environment, and
              correlation identifiers. Runtime exception messages sent to Sentry
              are replaced with a fixed sanitized message.
            </li>
            <li>
              Cloudflare Web Analytics performance and page-view measurements.
              Its browser beacon does not use cookies, local storage, session
              storage, or fingerprinting and does not retain the visitor IP in
              its analytics data.
            </li>
          </ul>

          <h3>Information you send us</h3>
          <p>
            If you use our contact form or email us, we receive your name and
            email address, the topic and message you provide, and related
            delivery metadata. Do not send passwords, caller API keys,
            payment-card data, or unnecessary review content in a support
            message.
          </p>
        </LegalSection>

        <LegalSection number={2} title="Sources of Information">
          <ul>
            <li>
              Directly from you when you create an account, use the review UI,
              subscribe, or contact us.
            </li>
            <li>
              From authorized caller software when it registers, authenticates,
              submits review items, reads outputs, downloads files, or
              acknowledges completed work.
            </li>
            <li>
              From Clerk and Stripe when they provide authentication and billing
              events needed to operate your account.
            </li>
            <li>
              Automatically from the application, API, command-line client,
              infrastructure, and observability systems when you use the
              Services.
            </li>
          </ul>
        </LegalSection>

        <LegalSection number={3} title="How We Use Information">
          <ul>
            <li>
              Provide and authenticate the hosted application, caller API,
              command-line flows, account membership, and billing features.
            </li>
            <li>
              Store review items, deliver them to an authorized human, return
              answers and files to the correct caller, and delete acknowledged
              or expired queue content.
            </li>
            <li>
              Enforce account boundaries, caller credentials, product limits,
              quotas, rate controls, retention, and abuse protections.
            </li>
            <li>
              Process subscriptions, reconcile billing status, handle payment
              failure and cancellation, and provide the billing portal.
            </li>
            <li>
              Monitor, secure, debug, and improve the Services and investigate
              failures, suspicious activity, and support requests.
            </li>
            <li>
              Enforce our Terms, protect our rights and users, respond to lawful
              requests, and comply with legal, tax, accounting, and security
              obligations.
            </li>
          </ul>
        </LegalSection>

        <LegalSection
          number={4}
          title="Cookies, Local Storage, and Local Credentials"
        >
          <ul>
            <li>
              Clerk uses necessary cookies and browser storage to secure
              sign-up, sign-in, and authenticated browser sessions.
            </li>
            <li>
              Cloudflare Web Analytics is configured as cookie-free performance
              and page-view analytics and does not access browser storage.
            </li>
            <li>
              The Agent Outbox command-line client stores non-secret connection
              configuration in its local config and stores caller credentials in
              the supported operating-system credential store. Those local
              values remain on your device except when a credential is sent to
              the hosted caller API for authentication.
            </li>
          </ul>
          <p>
            We do not currently use advertising cookies, cross-site behavioral
            advertising, or a marketing session-replay product. Blocking
            required authentication storage may prevent protected parts of the
            Services from working.
          </p>
        </LegalSection>

        <LegalSection number={5} title="How We Disclose Information">
          <p>
            We disclose information only as reasonably necessary to operate the
            Services, fulfill your requests, secure the platform, or comply with
            law.
          </p>
          <ul>
            <li>
              <strong>Clerk:</strong> authentication, account identity, and
              browser session management.
            </li>
            <li>
              <strong>Stripe:</strong> hosted Checkout and Billing Portal,
              customer and subscription administration, payment processing, and
              billing events.
            </li>
            <li>
              <strong>Cloudflare:</strong> DNS, hosted application and API
              execution, contact-form email delivery, request security,
              structured runtime logs, and privacy-oriented Web Analytics.
            </li>
            <li>
              <strong>Supabase:</strong> managed Postgres storage for accounts,
              callers, queue content, answers, file bytes, usage state, and
              audit records.
            </li>
            <li>
              <strong>Sentry:</strong> sanitized application exception grouping,
              releases, and source-map-assisted diagnostics.
            </li>
            <li>
              <strong>Zoho Mail:</strong> receipt and storage of contact-form
              and email messages delivered to contact@agent-outbox.dev.
            </li>
            <li>
              <strong>Professional advisors and legal process:</strong> lawyers,
              auditors, insurers, regulators, courts, or law enforcement when
              required or reasonably necessary.
            </li>
            <li>
              <strong>Business transfers:</strong> parties involved in a merger,
              financing, acquisition, reorganization, or sale of all or part of
              the business, subject to applicable obligations.
            </li>
          </ul>
          <p>
            We do not sell personal information and do not share it for
            cross-context behavioral advertising.
          </p>
        </LegalSection>

        <LegalSection number={6} title="Data Retention">
          <p>
            We retain information for as long as reasonably necessary to provide
            and secure the Services, satisfy legal and accounting obligations,
            resolve disputes, and enforce agreements. Primary queue content has
            these product-specific rules:
          </p>
          <ul>
            <li>
              Pending items on the hosted free tier are eligible for scheduled
              deletion after 60 days without an update. The hosted paid tier
              does not currently apply an automatic pending-item retention
              timeout.
            </li>
            <li>
              A caller can delete a pending item. A human answer remains linked
              to its output until the caller acknowledges it, the human undoes
              it before the first caller read, or timeout cleanup resolves it.
            </li>
            <li>
              Unacknowledged outputs, associated answers, matching input items,
              and uploaded file bytes are deleted no later than the 14-day
              output timeout. Acknowledgement deletes them earlier.
            </li>
            <li>
              Completed or abandoned caller setup requests and callers that
              never activate and have no meaningful history are generally
              eligible for cleanup after seven days.
            </li>
            <li>
              Processed Stripe webhook idempotency records are eligible for
              cleanup after 90 days. Billing and transaction records held by
              Stripe may be retained longer for tax, accounting, fraud, and
              legal purposes.
            </li>
            <li>
              Content-safe audit events are append-only operational history and
              do not currently have an automatic deletion window. Quota windows,
              temporary limit state, and IP rate-limit counters are pruned when
              their enforcement windows are no longer live.
            </li>
            <li>
              Logs, diagnostics, and contact messages are retained according to
              operational need and the configured retention of Cloudflare,
              Sentry, and Zoho Mail.
            </li>
          </ul>
          <p>
            We may retain limited information longer when required for security,
            fraud prevention, legal compliance, accounting, dispute resolution,
            or enforcement. Deletion from active systems may not immediately
            remove data from provider backups maintained for disaster recovery.
          </p>
        </LegalSection>

        <LegalSection number={7} title="Your Choices and Privacy Requests">
          <p>
            Depending on applicable law, you may have rights to request access,
            correction, deletion, or information about personal information we
            maintain. You may also be entitled to object to certain processing
            or appeal a denied request.
          </p>
          <ul>
            <li>
              Manage your authentication session through the Clerk-powered
              sign-in and sign-out experience.
            </li>
            <li>
              Manage subscription renewal and payment methods through the
              Stripe-hosted billing portal.
            </li>
            <li>
              Delete pending queue items and acknowledge handled outputs through
              authorized caller workflows, which removes their live queue and
              file content.
            </li>
            <li>
              Revoke caller credentials through the authorized rotate and revoke
              flows.
            </li>
          </ul>
          <p>
            Email privacy requests to{" "}
            <a href="mailto:contact@agent-outbox.dev">
              contact@agent-outbox.dev
            </a>
            . We may ask you to verify your identity and account authority
            before completing a request.
          </p>
        </LegalSection>

        <LegalSection number={8} title="International Processing">
          <p>
            Conn Castle Studios is based in the United States. The Services and
            their providers may process information in the United States and in
            other countries where those providers operate. Those locations may
            have data-protection laws different from the laws where you live.
          </p>
        </LegalSection>

        <LegalSection number={9} title="Children's Privacy">
          <p>
            Agent Outbox is not intended for anyone under 18. We do not
            knowingly collect personal information from children under 13. If
            you believe a child has provided personal information, contact us so
            we can review and address the issue.
          </p>
        </LegalSection>

        <LegalSection number={10} title="Security">
          <p>
            We use administrative, technical, and organizational measures
            designed to protect information, including authenticated access,
            account and caller authorization, restricted provider credentials,
            encryption in transit, database row-level security, credential
            digests, product limits, and content-safe logging and audit
            controls.
          </p>
          <p>
            No security measure is perfect. We cannot guarantee that information
            will always remain secure. You are responsible for protecting your
            devices, accounts, caller credentials, and connected systems.
          </p>
        </LegalSection>

        <LegalSection number={11} title="Changes to This Policy">
          <p>
            We may update this Policy to reflect changes in the Services, law,
            or our practices. We will post the revised version and update the
            last-updated date. If a change is material, we may provide
            additional notice through the Services or another appropriate means.
          </p>
        </LegalSection>

        <LegalSection number={12} title="Contact">
          <CompanyAddress />
          <p>
            For questions or privacy requests, email{" "}
            <a href="mailto:contact@agent-outbox.dev">
              contact@agent-outbox.dev
            </a>
            .
          </p>
        </LegalSection>
      </article>
    </main>
  );
}
