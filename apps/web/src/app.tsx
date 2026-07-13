const pendingSurfaces = ["Operations", "Work history", "Settings & controls"] as const;

export function App() {
  return (
    <div className="console-shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="Symphony Encore home">
          <span className="wordmark-mark" aria-hidden="true">
            SE
          </span>
          <span>
            <strong>Symphony Encore</strong>
            <small>Operator control plane</small>
          </span>
        </a>
        <div className="service-state" role="status">
          <span className="state-pulse" aria-hidden="true" />
          Foundation
        </div>
      </header>

      <aside className="rail" aria-label="Primary navigation">
        <p className="rail-index">ENCORE / 001</p>
        <nav>
          <ol>
            {pendingSurfaces.map((surface, index) => (
              <li key={surface}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <button type="button" disabled>
                  {surface}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <p className="rail-note">Durable state. Explicit authority. Evidence before motion.</p>
      </aside>

      <main>
        <section className="hero" aria-labelledby="foundation-heading">
          <p className="eyebrow">System initialization / Milestone 01</p>
          <h1 id="foundation-heading">Control plane foundation in progress</h1>
          <p className="hero-copy">
            Live operational data appears only after durable API records exist. This console will
            not fabricate issue counts, spend, checks, or service health while the control plane is
            under construction.
          </p>

          <div className="status-grid">
            <article>
              <span className="status-number">01</span>
              <div>
                <h2>Repository baseline</h2>
                <p>Toolchain, package boundaries, and canonical commands.</p>
              </div>
              <span className="status-tag active">Active</span>
            </article>
            <article>
              <span className="status-number">02</span>
              <div>
                <h2>Durable control plane</h2>
                <p>Contracts, SQLite records, transitions, and recovery.</p>
              </div>
              <span className="status-tag">Queued</span>
            </article>
            <article>
              <span className="status-number">03</span>
              <div>
                <h2>Operator surfaces</h2>
                <p>Authenticated dashboard, history, live logs, and controls.</p>
              </div>
              <span className="status-tag">Queued</span>
            </article>
          </div>
        </section>
      </main>

      <footer>
        <span>LOCAL / LOOPBACK</span>
        <span>NO DURABLE API CONNECTION</span>
      </footer>
    </div>
  );
}
