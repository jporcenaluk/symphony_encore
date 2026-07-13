import { Link, Outlet } from "@tanstack/react-router";

import { useOperatorSession } from "./api-session.js";
import { controlClient } from "./control-client.js";
import { LoginView } from "./login-view.js";

const navigation = [
  { label: "Operations", to: "/operations" },
  { label: "History", to: "/history" },
  { label: "Settings", to: "/settings" },
] as const;

export function ConsoleShell() {
  const { session, setSession } = useOperatorSession();
  if (session === null) {
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
