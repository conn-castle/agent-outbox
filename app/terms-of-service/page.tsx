import type { Metadata } from "next";
import Link from "next/link";

import {
  CompanyAddress,
  LegalSection
} from "../../src/components/legal/LegalDocument";

export const metadata: Metadata = {
  title: "Terms of Service | Agent Outbox",
  description: "Terms governing access to and use of Agent Outbox."
};

export default function TermsOfServicePage() {
  return (
    <main className="legal-main">
      <header className="legal-header">
        <p className="eyebrow">Legal</p>
        <h1 className="legal-title">Terms of Service</h1>
        <p className="legal-summary">
          These Terms govern your use of Agent Outbox, the hosted human-review
          queue and caller API. Please read them before using the service.
        </p>
        <p className="legal-updated">Last updated: August 14, 2026</p>
      </header>
      <article className="legal-content">
        <section className="legal-section">
          <p>
            These Terms of Service (&quot;Terms&quot;) are a binding agreement
            between you and Hardware Breakout LLC, doing business as Conn Castle
            Studios (&quot;Conn Castle Studios,&quot; &quot;Company,&quot;
            &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), and govern your
            access to and use of Agent Outbox.
          </p>
          <p>
            In these Terms, &quot;Services&quot; means the Agent Outbox website,
            sign-up and sign-in flows, hosted application, caller API,
            command-line software, support and contact paths, and billing flows.
            By accessing or using any part of the Services, you agree to these
            Terms. If you do not agree, do not use the Services.
          </p>
        </section>

        <LegalSection number={1} title="Eligibility and Authority">
          <p>
            You must be at least 18 years old and legally capable of entering
            into these Terms. If you use the Services for a company or other
            entity, you represent that you have authority to bind that entity,
            and &quot;you&quot; includes that entity.
          </p>
          <p>
            The Services are controlled from the United States and are intended
            for users and customers in the United States. They are not directed
            to residents of, or individuals located in, the European Union,
            European Economic Area, United Kingdom, or Switzerland. We may
            limit, suspend, or refuse access from unsupported countries or
            jurisdictions. If you access the Services from outside a supported
            location, you do so on your own initiative and are responsible for
            complying with local law.
          </p>
        </LegalSection>

        <LegalSection number={2} title="Service Description">
          <p>
            Agent Outbox is an asynchronous review queue. Authorized caller
            software can submit structured review items, a human can answer them
            through the hosted application, and the caller can retrieve and
            acknowledge the resulting output through the caller API or
            command-line software.
          </p>
          <p>
            Agent Outbox does not provide artificial-intelligence models, model
            access, agent execution, or downstream action execution. You are
            responsible for obtaining and maintaining the caller software,
            credentials, subscriptions, devices, networks, and third-party tools
            used with the Services, and for deciding whether and how to act on
            an answer returned through Agent Outbox.
          </p>
          <p>
            We may change, suspend, discontinue, restrict, or remove any part of
            the Services. Unless we separately agree in writing, the Services do
            not include dedicated support, an uptime commitment, a service-level
            agreement, a data-recovery commitment, or an obligation to maintain
            a particular feature, integration, limit, region, or third-party
            compatibility path.
          </p>
        </LegalSection>

        <LegalSection number={3} title="Accounts, Callers, and Security">
          <ul>
            <li>
              You are responsible for maintaining the confidentiality of your
              account sessions, caller API keys, local credentials, and
              connected systems.
            </li>
            <li>
              You must provide accurate account and billing information and keep
              it current.
            </li>
            <li>
              You are responsible for activity performed through your account
              and authorized callers, including review items they submit and
              outputs they retrieve.
            </li>
            <li>
              You must promptly revoke affected caller credentials and notify us
              at{" "}
              <a href="mailto:contact@agent-outbox.dev">
                contact@agent-outbox.dev
              </a>{" "}
              if you suspect unauthorized access or a security incident.
            </li>
          </ul>
        </LegalSection>

        <LegalSection
          number={4}
          title="Plans, Billing, Renewal, and Cancellation"
        >
          <p>
            Agent Outbox may offer free and paid hosted plans. Plan features,
            limits, and pricing may change. Paid plans are billed through
            Stripe. Unless checkout says otherwise, prices are in U.S. dollars
            and exclude taxes, duties, levies, and similar charges.
          </p>
          <ul>
            <li>Paid subscriptions renew automatically until canceled.</li>
            <li>
              You authorize us and Stripe to charge the recurring fees, taxes,
              and other amounts disclosed at checkout or in the billing portal.
            </li>
            <li>
              You can cancel renewal through the Stripe-hosted billing portal.
              Cancellation takes effect at the end of the current paid period
              and stops future renewal charges.
            </li>
            <li>
              Payments are not retroactively refundable except where required by
              law or expressly stated by us in writing.
            </li>
            <li>
              We may suspend, restrict, or downgrade paid access if payment
              fails, a charge is reversed, or we reasonably suspect fraud or
              abuse.
            </li>
          </ul>
        </LegalSection>

        <LegalSection number={5} title="Your Content and Connected Systems">
          <p>
            You retain ownership of review items, answers, uploaded files,
            caller metadata, and other content you submit to the Services
            (&quot;Your Content&quot;). You grant us a non-exclusive, worldwide,
            royalty-free license to host, copy, transmit, process, and delete
            Your Content only as needed to operate, secure, support, and improve
            the Services or comply with law.
          </p>
          <p>
            You represent that you have the rights and permissions needed to use
            Your Content and connected systems with Agent Outbox. You are solely
            responsible for reviewing answers before relying on them and for any
            downstream action performed by you or your caller software.
          </p>
          <p>
            The Services interoperate with third-party providers and software,
            including authentication, hosting, database, billing, observability,
            and caller tooling. Those products are governed by their own terms
            and policies. We are not responsible for their acts, omissions,
            outages, or changes.
          </p>
        </LegalSection>

        <LegalSection
          number={6}
          title="Service License and Intellectual Property"
        >
          <p>
            Subject to these Terms, we grant you a limited, revocable,
            non-exclusive, non-transferable right to use the hosted Services for
            your internal personal or business purposes.
          </p>
          <p>
            Agent Outbox source code made available through its public
            repository is separately licensed under the{" "}
            <a href="https://github.com/conn-castle/agent-outbox/blob/main/LICENSE">
              PolyForm Perimeter License 1.0.1
            </a>
            . It permits internal use and modification, including commercial
            internal operations, but prohibits providing others a product that
            competes with Agent Outbox, including a competing hosted service.
          </p>
          <p>
            That software license, rather than this hosted-service license,
            controls your rights to copy, modify, or distribute that source
            code. It does not grant access to the hosted Services or change
            free- or paid-plan features, limits, pricing, or other terms of
            these Terms.
          </p>
          <p>
            The Agent Outbox and Conn Castle Studios names, marks,
            hosted-service presentation, visual assets, and other materials not
            expressly covered by the public software license remain owned by
            Conn Castle Studios or its licensors. We reserve all rights not
            expressly granted.
          </p>
        </LegalSection>

        <LegalSection number={7} title="Acceptable Use">
          <p>You agree not to:</p>
          <ul>
            <li>
              use the Services in violation of law, regulation, or the rights of
              others;
            </li>
            <li>
              submit content you do not have the right to process or disclose;
            </li>
            <li>
              interfere with or disrupt the Services, provider infrastructure,
              networks, or connected systems;
            </li>
            <li>
              attempt to bypass account boundaries, caller authorization,
              product limits, rate controls, billing controls, or security
              protections;
            </li>
            <li>
              probe, scan, scrape, or reverse engineer the hosted Services
              except as permitted by law or the public software license;
            </li>
            <li>
              use the Services to store, transmit, or facilitate malicious code,
              credential theft, spam, unlawful surveillance, or infringement; or
            </li>
            <li>
              use the Services in a way that could expose us, our providers, or
              other users to security, legal, reputational, or operational harm.
            </li>
          </ul>
        </LegalSection>

        <LegalSection number={8} title="Feedback">
          <p>
            If you send us feedback, ideas, or suggestions about the Services,
            you grant us a worldwide, perpetual, irrevocable, transferable,
            sublicensable, royalty-free license to use, modify, publish, and
            incorporate that feedback without compensation or obligation to you.
          </p>
        </LegalSection>

        <LegalSection number={9} title="Suspension and Termination">
          <p>
            We may suspend or terminate access to the Services if we reasonably
            believe you violated these Terms, created legal or security risk,
            failed to pay required fees, or used the Services in a way that
            could harm us, our providers, or other users.
          </p>
          <p>
            You may stop using the Services at any time. Provisions that by
            their nature should survive termination will survive, including
            ownership, payment obligations, disclaimers, liability limits,
            indemnification, and dispute resolution.
          </p>
        </LegalSection>

        <LegalSection number={10} title="Disclaimer of Warranties">
          <p>
            THE SERVICES ARE PROVIDED &quot;AS IS&quot; AND &quot;AS
            AVAILABLE.&quot; TO THE MAXIMUM EXTENT PERMITTED BY LAW, CONN CASTLE
            STUDIOS DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS, IMPLIED,
            STATUTORY, OR OTHERWISE, INCLUDING WARRANTIES OF MERCHANTABILITY,
            FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, QUIET ENJOYMENT,
            AND WARRANTIES ARISING OUT OF COURSE OF DEALING OR USAGE OF TRADE.
          </p>
          <p>
            WE DO NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED,
            ERROR-FREE, SECURE, OR FREE OF HARMFUL COMPONENTS, OR THAT ANY
            REVIEW ITEM, ANSWER, FILE, CALLER OUTPUT, OR OTHER INFORMATION WILL
            BE ACCURATE, COMPLETE, AVAILABLE, OR FIT FOR YOUR PURPOSES.
          </p>
        </LegalSection>

        <LegalSection number={11} title="Limitation of Liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, CONN CASTLE STUDIOS AND ITS
            OFFICERS, DIRECTORS, EMPLOYEES, CONTRACTORS, AFFILIATES, LICENSORS,
            AND SERVICE PROVIDERS WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL,
            SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOSS
            OF PROFITS, REVENUE, GOODWILL, DATA, BUSINESS INTERRUPTION, OR OTHER
            INTANGIBLE LOSSES ARISING OUT OF OR RELATED TO THE SERVICES OR THESE
            TERMS.
          </p>
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL AGGREGATE
            LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THE SERVICES
            OR THESE TERMS WILL NOT EXCEED THE GREATER OF (A) THE AMOUNTS YOU
            PAID TO US FOR THE SERVICES IN THE TWELVE MONTHS BEFORE THE EVENT
            GIVING RISE TO THE CLAIM OR (B) ONE HUNDRED U.S. DOLLARS (US $100).
          </p>
        </LegalSection>

        <LegalSection number={12} title="Indemnification">
          <p>
            You will defend, indemnify, and hold harmless Conn Castle Studios
            and its officers, directors, employees, contractors, affiliates,
            licensors, and service providers from third-party claims, demands,
            actions, or proceedings, and resulting damages, judgments,
            settlements, penalties, fines, costs, and reasonable attorneys&apos;
            fees, to the extent arising from Your Content or connected systems,
            your material violation of these Terms, your violation of law or a
            third-party right, or your willful misconduct or misuse of the
            Services. This obligation does not apply to the extent a claim was
            caused by Conn Castle Studios&apos; negligence, willful misconduct,
            violation of law, or breach of these Terms.
          </p>
          <p>
            We will provide prompt written notice of an indemnified claim and
            reasonable cooperation at your expense. You may control its defense
            and settlement, but you may not settle a claim in a way that admits
            fault by, or imposes a non-monetary obligation on, Conn Castle
            Studios without our written consent. We may participate with counsel
            of our choice at our own expense.
          </p>
        </LegalSection>

        <LegalSection number={13} title="Governing Law and Dispute Resolution">
          <p>
            These Terms and disputes arising out of or relating to them or the
            Services are governed by New York law, without regard to
            conflict-of-law rules.
          </p>
          <p>
            Before starting formal proceedings, you and Conn Castle Studios
            agree to try to resolve the dispute through written notice and a
            30-day discussion period.
          </p>
          <p>
            For purposes of this section, a &quot;Consumer Dispute&quot; is a
            dispute arising from an individual&apos;s use of the Services for
            personal, family, or household purposes. Except for disputes
            eligible for small claims court, requests for temporary or
            preliminary injunctive relief, or intellectual-property misuse
            claims, unresolved disputes will be resolved by final and binding
            arbitration administered by the American Arbitration Association
            (&quot;AAA&quot;).
          </p>
          <p>
            Consumer Disputes will be governed by the AAA Consumer Arbitration
            Rules and Mediation Procedures and the AAA Consumer Due Process
            Protocol. All other disputes will be governed by the AAA Commercial
            Arbitration Rules and Mediation Procedures. If these Terms conflict
            with an applicable AAA rule in a way that would prevent the AAA from
            administering the arbitration, the applicable AAA rule controls.
          </p>
          <p>
            For a Consumer Dispute, the hearing may proceed by documents,
            telephone, video conference, or in person as permitted by the AAA
            Consumer Arbitration Rules. Any in-person consumer hearing will be
            held at a reasonably convenient location determined under those
            rules. For a non-consumer dispute, any in-person hearing will be
            held in Monroe County, New York, unless the parties or the
            arbitrator agree to another location.
          </p>
          <p>
            AAA filing, administration, hearing, and arbitrator fees will be
            allocated under the applicable AAA rules and law. For a Consumer
            Dispute, Conn Castle Studios will pay the fees and arbitrator
            compensation the AAA rules require the business to pay and will not
            seek reimbursement from the consumer unless the arbitrator
            determines that the claim was filed for harassment or was patently
            frivolous. Each party will otherwise bear its own attorneys&apos;
            fees and costs unless applicable law or the arbitrator permits an
            award of those amounts.
          </p>
          <p>
            The arbitrator may award any individual remedy available in court
            under applicable law, subject to enforceable limitations in these
            Terms. The award will be final and binding, and judgment on it may
            be entered in any court with jurisdiction.
          </p>
          <p>
            YOU AND CONN CASTLE STUDIOS MAY BRING CLAIMS ONLY IN AN INDIVIDUAL
            CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN A CLASS,
            COLLECTIVE, CONSOLIDATED, OR REPRESENTATIVE ACTION. THE ARBITRATOR
            MAY AWARD RELIEF ONLY TO THE INDIVIDUAL PARTY SEEKING RELIEF AND
            ONLY AS NEEDED TO RESOLVE THAT PARTY&apos;S CLAIM.
          </p>
          <p>
            If that class-action waiver is unenforceable for a particular claim
            or request for relief, that matter must be litigated in the state or
            federal courts located in Monroe County, New York, unless applicable
            law gives a consumer the right to proceed in another court. The
            remaining disputes must stay in arbitration. If any other part of
            this arbitration agreement is unenforceable, it will be severed and
            the remainder will remain in effect.
          </p>
        </LegalSection>

        <LegalSection number={14} title="Changes to These Terms">
          <p>
            We may update these Terms. We will post revised Terms and update the
            last-updated date. If a revision is material, we may provide
            additional notice through the Services or another reasonable means.
            Unless stated otherwise, changes take effect when posted. Continued
            use after the effective date means you accept the revised Terms.
          </p>
        </LegalSection>

        <LegalSection number={15} title="Contact">
          <CompanyAddress />
          <p>
            For legal notices or questions about these Terms, email{" "}
            <a href="mailto:contact@agent-outbox.dev">
              contact@agent-outbox.dev
            </a>
            . Information about our data practices is available in the{" "}
            <Link href="/privacy-policy">Privacy Policy</Link>.
          </p>
        </LegalSection>
      </article>
    </main>
  );
}
