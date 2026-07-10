import Link from "next/link";
import type { ReactNode } from "react";

export function LegalSection({
  number,
  title,
  children
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="legal-section">
      <h2>
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

export function CompanyAddress() {
  return (
    <address className="legal-address">
      Conn Castle Studios
      <br />
      Hardware Breakout LLC
      <br />
      3 Cressier Ct.
      <br />
      Fairport, NY 14450
    </address>
  );
}

export function LegalAcknowledgement({ action }: { action: string }) {
  return (
    <p className="legal-acknowledgement">
      By {action}, you agree to the{" "}
      <Link href="/terms-of-service">Terms of Service</Link> and acknowledge the{" "}
      <Link href="/privacy-policy">Privacy Policy</Link>.
    </p>
  );
}
