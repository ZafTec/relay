import { usePageMetadata } from "../../app/usePageMetadata";
import { PublicLayout } from "../../components/layout/PublicLayout";
import { Diagram } from "../../components/ui/Diagram";
import { LinkButton } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { Link } from "react-router-dom";
import "./landing.css";

const heroAlt = "An AI agent calls a registry tool, Relay runs the work asynchronously, stores an output set as durable artifacts, and returns a managed URL.";
const meterAlt = "Usage moves from an estimate to a held reservation, provider use, and final settlement, with release after an early failure.";
const retryAlt = "Relay retries only before provider submission, reconciles confirmed submissions, and does not retry deterministic validation or policy failures.";

const questions = [
  { question: "What can I do with Relay?", answer: "Connect an AI agent to a curated tool catalog, run work in the background, and keep the resulting files in a workspace. Your dashboard brings tools, runs, files, and usage together." },
  { question: "How do I connect my AI agent?", answer: "Sign in with Google or GitHub, then copy the MCP URL from Settings into your agent’s connected-app settings. Compatible agents register automatically. If your agent asks for a client ID and secret, create an OAuth client using the callback URL it provides. You choose the workspace and approve permissions when connecting." },
  { question: "Does signing in give me tool access?", answer: "Signing in creates or resumes your personal workspace. Running a tool also requires permission to execute it and an allowance for its usage. Check the Tools page and Usage page for your workspace’s current access, and contact an administrator if you need an allowance." },
  { question: "Can I keep different projects separate?", answer: "Yes. Create a workspace in Settings and use the workspace switcher to move between projects. Runs, files, and usage belong to the workspace where the work happens. An agent’s connection stays bound to the workspace you approved for it." },
  { question: "Are my result files public?", answer: "Files stay in your workspace. You can create a share link when you want to give someone access, choose its access policy, and revoke it later. New file versions preserve the earlier versions so you can review what changed." },
  { question: "What happens if a run fails?", answer: "Open the run to see its status, any returned results, and the recorded usage. Relay releases reservations after eligible early failures. Work already submitted to a provider may still consume usage, so a failure does not always mean zero usage." },
] as const;

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
              caption="From tool discovery to a stored result, every step stays connected to your workspace."
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
            <h2 className="availability-heading">Start with a workspace. Connect the tools you need.</h2>
            <div className="availability-ledger">
              <article>
                <span className="landing-step">01</span>
                <h3>Sign in to your workspace</h3>
                <p>Use Google or GitHub. Keep each project’s files, runs, and usage together.</p>
              </article>
              <article>
                <span className="landing-step">02</span>
                <h3>Connect your agent</h3>
                <p>Add your MCP URL, choose a workspace, and approve the permissions your agent needs.</p>
              </article>
              <article>
                <span className="landing-step">03</span>
                <h3>Check your tool access</h3>
                <p>Your catalog shows the tools available to your workspace. Execution requires an explicit usage allowance.</p>
              </article>
            </div>
          </div>
        </section>

        <section className="landing-section landing-section--paper-2" id="faq" aria-labelledby="faq-title">
          <div className="landing-container landing-faq">
            <div className="landing-faq__intro">
              <p className="kicker">Before you get started</p>
              <h2 id="faq-title">Frequently asked questions</h2>
              <p>A few useful answers about connecting agents, workspace access, and your results.</p>
              <Link to="/docs">Explore the documentation <span aria-hidden="true">→</span></Link>
            </div>
            <div className="landing-faq__questions">
              {questions.map(({ question, answer }) => <Disclosure key={question} title={question}><p>{answer}</p></Disclosure>)}
            </div>
          </div>
        </section>

        <section className="landing-cta product-surface">
          <div className="landing-container landing-cta__inner">
            <div>
              <p className="kicker kicker--product">Enter Relay</p>
              <h2>Authorize once. Keep every result accountable.</h2>
            </div>
            <LinkButton to="/sign-in" endGlyph="→">Sign in</LinkButton>
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}
