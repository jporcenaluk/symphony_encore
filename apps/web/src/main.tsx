import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { createConsoleRouter } from "./router.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Operator console root element is missing");

const queryClient = new QueryClient();
const router = createConsoleRouter();

createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} router={router} />
  </StrictMode>,
);
