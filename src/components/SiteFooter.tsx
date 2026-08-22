import Link from "next/link";

import packageJson from "../../package.json";
import { formatVersionLabel } from "../server/app-version";
import { websiteHref } from "../server/hosted-hrefs";

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export async function SiteFooter() {
  const [
    installationHref,
    howItWorksHref,
    pricingHref,
    docsHref,
    contactHref,
    privacyHref,
    termsHref
  ] = await Promise.all([
    websiteHref("/#installation"),
    websiteHref("/#how-it-works"),
    websiteHref("/#pricing"),
    websiteHref("/docs/api"),
    websiteHref("/contact"),
    websiteHref("/privacy-policy"),
    websiteHref("/terms-of-service")
  ]);
  return (
    <footer className="site-footer">
      <div className="footer-main">
        <div className="footer-brand">
          <a
            className="footer-studio-mark"
            href="https://conncastlestudios.com"
          >
            <img
              src="/conn-castle-logo.svg"
              alt="Conn Castle Studios"
              width="900"
              height="556"
            />
          </a>
          <div>
            <p className="footer-product">
              Agent <b>Outbox</b>
            </p>
            <p>
              Brought to you by{" "}
              <a href="https://conncastlestudios.com">Conn Castle Studios</a>.
            </p>
            <p>An asynchronous human review queue for AI agents.</p>
          </div>
        </div>
        <nav className="footer-navigation" aria-label="Footer">
          <div>
            <p>Product</p>
            <Link href={installationHref}>Installation</Link>
            <Link href={howItWorksHref}>How it works</Link>
            <Link href={pricingHref}>Pricing</Link>
          </div>
          <div>
            <p>Resources</p>
            <Link href={docsHref}>API docs</Link>
            <a href="https://github.com/conn-castle/agent-outbox">GitHub</a>
            <Link href={contactHref}>Contact</Link>
          </div>
        </nav>
      </div>
      <div className="footer-meta">
        <p>
          &copy; {new Date().getUTCFullYear()} Conn Castle Studios. All rights
          reserved.
        </p>
        <div className="footer-meta-links">
          <nav className="footer-legal-links" aria-label="Legal">
            <Link href={privacyHref}>Privacy Policy</Link>
            <Link href={termsHref}>Terms of Service</Link>
            <a href="https://github.com/conn-castle/agent-outbox/blob/main/LICENSE">
              Software License
            </a>
          </nav>
          <a
            className="footer-github"
            href="https://github.com/conn-castle/agent-outbox"
            aria-label="Agent Outbox on GitHub"
          >
            <GitHubMark />
          </a>
          <span className="footer-version">
            {formatVersionLabel(packageJson.version)}
          </span>
        </div>
      </div>
    </footer>
  );
}
