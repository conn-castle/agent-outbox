import { ContactForm } from "./ContactForm";

export default function ContactPage() {
  return (
    <main className="legal-main contact-main">
      <div className="contact-intro">
        <p className="eyebrow">Contact</p>
        <h1 className="legal-title">
          Talk to the people building Agent Outbox.
        </h1>
        <p className="legal-summary">
          Caller access requests, product questions, billing, partnerships,
          privacy, and support go directly to the Agent Outbox team.
        </p>
        <div className="contact-note">
          <p className="contact-note-label">Before you send</p>
          <p>
            Include a relevant error ID when reporting a problem. Never send
            passwords, API keys, payment-card details, or sensitive review
            content.
          </p>
        </div>
        <a
          className="contact-issue-link"
          href="https://github.com/conn-castle/agent-outbox/issues"
        >
          Reporting a reproducible bug? Open a GitHub issue
          <span aria-hidden="true">↗</span>
        </a>
      </div>

      <section
        className="contact-form-card"
        aria-labelledby="contact-form-title"
      >
        <p className="contact-form-index">Get in touch</p>
        <h2 id="contact-form-title">How can we help?</h2>
        <ContactForm />
      </section>
    </main>
  );
}
