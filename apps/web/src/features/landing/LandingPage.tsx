import { usePageMetadata } from "../../app/usePageMetadata";
import { PublicLayout } from "../../components/layout/PublicLayout";
import { Diagram } from "../../components/ui/Diagram";
import { LinkButton } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";

const heroAlt = "An AI agent calls a registry tool, Relay runs the work asynchronously, stores an output set as durable artifacts, and returns a managed URL.";
const meterAlt = "Usage moves from an estimate to a held reservation, provider use, and final settlement, with release after an early failure.";
const retryAlt = "Relay retries only before provider submission, reconciles confirmed submissions, and does not retry deterministic validation or policy failures.";

export function LandingPage() {
  usePageMetadata("Relay | Metered tools for AI agents", "#F5F4ED");

  return (
    <PublicLayout>
      <main id="main-content">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-container">
            <p className="kicker"><span>// 01</span> Tool and artifact infrastructure</p>
            <h1 id="landing-title">Metered tools for agents. Durable URLs for every result.</h1>
            <div className="landing-hero__summary">
              <p>
                Relay lets AI agents discover curated tools, run long work asynchronously,
                and receive versioned artifacts through Relay-managed URLs.
              </p>
              <div className="landing-actions">
                <LinkButton to="/sign-in" variant="ink" endGlyph="→">Sign in</LinkButton>
                <a className="button button--outline" href="#platform">
                  <span className="button__label">See the flow</span>
                </a>
              </div>
            </div>
            <Diagram
              className="landing-hero__diagram"
              src="/relay/assets/hero-agent-to-artifact.svg"
              alt={heroAlt}
              label="Agent to artifact delivery flow"
              minWidth={900}
              caption="Illustrative architecture. Production image providers, tool names, and public share paths are not announced."
            />
          </div>
        </section>

        <section className="landing-section landing-section--paper-2" id="platform">
          <div className="landing-container">
            <p className="kicker"><span>// 02</span> One durable contract</p>
            <div className="platform-grid">
              <div className="platform-grid__lead">
                <h2>A tool call should outlive the request that started it.</h2>
                <p>
                  Relay separates a stable tool contract from asynchronous execution,
                  provider details, stored outputs, and managed delivery.
                </p>
              </div>
              <ol className="ledger-list">
                <li>
                  <span className="ledger-list__number">01</span>
                  <div><strong>Discover</strong><p>Read a versioned input, output, and meter contract.</p></div>
                </li>
                <li>
                  <span className="ledger-list__number">02</span>
                  <div><strong>Run</strong><p>Receive a durable run identity while work continues asynchronously.</p></div>
                </li>
                <li>
                  <span className="ledger-list__number">03</span>
                  <div><strong>Deliver</strong><p>Resolve output artifacts through revocable Relay-managed URLs.</p></div>
                </li>
              </ol>
            </div>
          </div>
        </section>

        <section className="landing-section" id="metering">
          <div className="landing-container landing-split">
            <div className="landing-split__copy">
              <p className="kicker"><span>// 03</span> Meter before execution</p>
              <h2>Estimate, reserve, then settle.</h2>
              <p>
                Relay accounts for every accepted invocation. A reservation prevents
                concurrent overspend, then settles against actual use or releases after
                an eligible early failure.
              </p>
              <div className="proof-list" aria-label="Metering guarantees">
                <span><b aria-hidden="true">■</b> Estimate is not a final charge</span>
                <span><b aria-hidden="true">■</b> Reservation precedes provider work</span>
                <span><b aria-hidden="true">■</b> Customer usage stays separate from provider cost</span>
              </div>
            </div>
            <Diagram
              src="/relay/assets/meter-path.svg"
              alt={meterAlt}
              label="Relay meter path"
              minWidth={680}
            />
          </div>
        </section>

        <section className="landing-section landing-section--paper-2">
          <div className="landing-container landing-split landing-split--reverse">
            <Diagram
              src="/relay/assets/retry-decision.svg"
              alt={retryAlt}
              label="Relay retry decision flow"
              minWidth={620}
            />
            <div className="landing-split__copy">
              <p className="kicker"><span>// 04</span> Failure stays inspectable</p>
              <h2>Retry only when the evidence says it is safe.</h2>
              <p>
                Relay records attempts and submission certainty. Confirmed provider work
                is reconciled instead of blindly submitted twice.
              </p>
            </div>
          </div>
        </section>

        <section className="landing-section" id="availability">
          <div className="landing-container">
            <p className="kicker"><span>// 05</span> Availability</p>
            <h2 className="availability-heading">The platform model is established. Provider features are not presented as shipped.</h2>
            <div className="availability-ledger">
              <article>
                <StatusBadge tone="ready">Foundation</StatusBadge>
                <h3>OAuth and workspace foundation</h3>
                <p>Google and GitHub are the only supported browser sign-in methods. Each session carries an active workspace context.</p>
              </article>
              <article>
                <StatusBadge tone="pending">Planned, not shipped</StatusBadge>
                <h3>Provider-backed image tools</h3>
                <p>Provider names, model names, pricing, latency, and fallback behavior remain unannounced.</p>
              </article>
              <article>
                <StatusBadge tone="warning">Asset required</StatusBadge>
                <h3>Generated image examples</h3>
                <p>No sample output is shown until licensed images and provenance are supplied.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="landing-cta product-surface">
          <div className="landing-container landing-cta__inner">
            <div>
              <p className="kicker kicker--product"><span>// 06</span> Enter Relay</p>
              <h2>Authorize once. Keep every result accountable.</h2>
            </div>
            <LinkButton to="/sign-in" endGlyph="→">Sign in</LinkButton>
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}
