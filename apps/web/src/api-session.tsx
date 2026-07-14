import type { LoginResponse } from "@symphony/contracts";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface OperatorSession {
  csrfToken: string;
  expiresAt: string;
  operator: LoginResponse["operator"];
}

interface SessionContextValue {
  session: OperatorSession | null;
  setSession(session: OperatorSession | null): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
  initialSession = null,
}: {
  children: ReactNode;
  initialSession?: OperatorSession | null;
}) {
  const [session, setSession] = useState<OperatorSession | null>(initialSession);
  const value = useMemo(() => ({ session, setSession }), [session]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useOperatorSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (context === null) throw new Error("Operator session provider is missing");
  return context;
}
