import { ControlApiClientError } from "@symphony/contracts";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useOperatorSession } from "./api-session.js";
import { BootstrapView } from "./bootstrap-view.js";
import { controlClient } from "./control-client.js";
import { LoginView } from "./login-view.js";

const navigation = [
  { label: "Operations", to: "/operations" },
  { label: "History", to: "/history" },
  { label: "Settings", to: "/settings" },
] as const;

export function ConsoleShell() {
  const { session, setSession } = useOperatorSession();
  const [bootstrap, setBootstrap] = useState<
    | { kind: "checking" }
    | { candidateHash: string; kind: "required" }
    | { kind: "disabled" }
    | { kind: "error" }
  >({ kind: "checking" });
  useEffect(() => {
    if (session !== null || bootstrap.kind !== "checking") return;
    let active = true;
    void controlClient.getBootstrapStatus().then(
      (status) => {
        if (active) setBootstrap({ candidateHash: status.candidate_hash, kind: "required" });
      },
      (error: unknown) => {
        if (!active) return;
        setBootstrap(
          error instanceof ControlApiClientError && error.status === 404
            ? { kind: "disabled" }
            : { kind: "error" },
        );
      },
    );
    return () => {
      active = false;
    };
  }, [bootstrap.kind, session]);
  if (session === null) {
    if (bootstrap.kind === "checking") {
      return (
        <main className="login-stage">
          <section className="login-card" aria-live="polite">
            Inspecting local authority state…
          </section>
        </main>
      );
    }
    if (bootstrap.kind === "required") {
      return (
        <BootstrapView
          candidateHash={bootstrap.candidateHash}
          completeBootstrap={controlClient.completeBootstrap}
          onCompleted={() => setBootstrap({ kind: "disabled" })}
        />
      );
    }
    if (bootstrap.kind === "error") {
      return (
        <main className="login-stage">
          <section className="login-card" role="alert">
            <p className="eyebrow">Control API unavailable</p>
            <h1>Authority state unknown</h1>
            <p>The console will not guess whether bootstrap or authenticated login is active.</p>
          </section>
        </main>
      );
    }
    return <LoginView login={controlClient.login} onAuthenticated={setSession} />;
  }
  return (
    <div className="console-shell">
      <header className="masthead">
        <Link className="wordmark" to="/operations" aria-label="Symphony Encore operations">
          <span className="wordmark-mark" aria-hidden="true">
            SE
          </span>
          <span>
            <strong>Symphony Encore</strong>
            <small>Operator control plane</small>
          </span>
        </Link>
        <div className="service-state" role="status">
          <span className="state-pulse" aria-hidden="true" />
          Control API
        </div>
      </header>

      <aside className="rail" aria-label="Primary navigation">
        <p className="rail-index">ENCORE / LOCAL</p>
        <nav>
          <ol>
            {navigation.map((item, index) => (
              <li key={item.to}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <Link activeProps={{ className: "active" }} to={item.to}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <p className="rail-note">Durable state. Explicit authority. Evidence before motion.</p>
      </aside>

      <main className="console-main">
        <Outlet />
      </main>

      <footer>
        <span>LOCAL / LOOPBACK</span>
        <span>CONTROL API / DURABLE READS</span>
      </footer>
    </div>
  );
}
