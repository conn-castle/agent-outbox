import { Mail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { CompanyAddress } from "../../src/components/legal/LegalDocument";

export const metadata: Metadata = {
  title: "Contact | Agent Outbox",
  description:
    "Contact Conn Castle Studios about Agent Outbox support, billing, privacy, security, abuse, or legal matters."
};

export default function ContactPage() {
  return (
    <main className="legal-main">
      <header className="legal-header">
        <p className="eyebrow">Contact</p>
        <h1 className="legal-title">Contact Agent Outbox</h1>
        <p className="legal-summary">
          Use the Agent Outbox inbox for support, billing, privacy, security,
          abuse, copyright, or legal questions.
        </p>
        <div className="contact-actions">
          <a className="button" href="mailto:contact@agent-outbox.dev">
            <Mail aria-hidden="true" size={18} />
            Email contact@agent-outbox.dev
          </a>
        </div>
      </header>

      <div className="legal-content">
        <section className="legal-section">
          <h2>What to include</h2>
          <p>
            Include the account email, the affected caller name when relevant,
            and any visible error or request identifier. Describe the expected
            and actual result without sending passwords, caller API keys,
            payment-card details, or unnecessary queue and file content.
          </p>
        </section>

        <section className="legal-section">
          <h2>Security and abuse reports</h2>
          <p>
            Put <strong>Security</strong> or <strong>Abuse</strong> in the email
            subject. Include the affected URL, approximate UTC time, and a
            concise description that lets us investigate without reproducing
            harmful activity against the production service.
          </p>
        </section>

        <section className="legal-section">
          <h2>Privacy and legal requests</h2>
          <p>
            State the request and the account email involved. We may ask you to
            verify identity and account authority. Review the{" "}
            <Link href="/privacy-policy">Privacy Policy</Link> and{" "}
            <Link href="/terms-of-service">Terms of Service</Link> for the
            current service commitments.
          </p>
        </section>

        <section className="legal-section">
          <h2>Mailing address</h2>
          <CompanyAddress />
        </section>
      </div>
    </main>
  );
}
