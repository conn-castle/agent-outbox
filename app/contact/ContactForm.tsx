"use client";

import { useState, type FormEvent } from "react";

type FormStatus =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "success" }
  | { state: "error"; message: string };

export function ContactForm() {
  const [status, setStatus] = useState<FormStatus>({ state: "idle" });

  async function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setStatus({ state: "sending" });

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(formData))
      });
      const result = (await response.json()) as {
        ok?: boolean;
        message?: string;
      };

      if (!response.ok || !result.ok) {
        setStatus({
          state: "error",
          message:
            result.message ?? "Your message was not sent. Please try again."
        });
        return;
      }

      form.reset();
      setStatus({ state: "success" });
    } catch {
      setStatus({
        state: "error",
        message:
          "Your message was not sent. Check your connection and try again."
      });
    }
  }

  const sending = status.state === "sending";

  return (
    <form className="contact-form" onSubmit={submitContact}>
      <div className="contact-field-row">
        <label className="contact-field">
          <span>Name</span>
          <input
            type="text"
            name="name"
            autoComplete="name"
            minLength={2}
            maxLength={80}
            required
          />
        </label>
        <label className="contact-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            maxLength={254}
            required
          />
        </label>
      </div>

      <label className="contact-field">
        <span>What can we help with?</span>
        <select name="topic" defaultValue="" required>
          <option value="" disabled>
            Select a topic
          </option>
          <option>Caller access</option>
          <option>Product question</option>
          <option>Billing</option>
          <option>Partnership</option>
          <option>Privacy</option>
          <option>Support</option>
          <option>Something else</option>
        </select>
      </label>

      <label className="contact-field">
        <span>Message</span>
        <textarea
          name="message"
          rows={7}
          minLength={20}
          maxLength={4000}
          placeholder="Tell us what you’re working on and how we can help."
          required
        />
      </label>

      <label className="contact-honeypot" aria-hidden="true">
        Company
        <input name="company" type="text" tabIndex={-1} autoComplete="off" />
      </label>

      <div className="contact-submit-row">
        <button
          className="button"
          type="submit"
          disabled={sending}
          data-immediate-action-label="Sending…"
        >
          <span data-immediate-action-feedback suppressHydrationWarning>
            {sending ? "Sending…" : "Send message"}
          </span>
        </button>
        <p
          className={`contact-form-status${status.state === "error" ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {status.state === "success"
            ? "Message sent. We’ll get back to you soon."
            : status.state === "error"
              ? status.message
              : "We usually reply within two business days."}
        </p>
      </div>
    </form>
  );
}
