import Link from "next/link";

import { appHref, websiteHref } from "../server/hosted-hrefs";
import { SiteNav } from "./SiteNav";

export async function SiteHeader() {
  const [
    homeHref,
    signInHref,
    signUpHref,
    installationHref,
    howItWorksHref,
    pricingHref,
    docsHref
  ] = await Promise.all([
    websiteHref("/"),
    appHref("/sign-in"),
    appHref("/sign-up"),
    websiteHref("/#installation"),
    websiteHref("/#how-it-works"),
    websiteHref("/#pricing"),
    websiteHref("/docs/api")
  ]);
  return (
    <header className="topbar">
      <Link className="brand product-wordmark" href={homeHref}>
        <img src="/agent-outbox-mark.svg" alt="" width="44" height="44" />
        <span>
          Agent <b>Outbox</b>
        </span>
      </Link>
      <SiteNav
        installationHref={installationHref}
        howItWorksHref={howItWorksHref}
        pricingHref={pricingHref}
        docsHref={docsHref}
        signInHref={signInHref}
        signUpHref={signUpHref}
      />
    </header>
  );
}
