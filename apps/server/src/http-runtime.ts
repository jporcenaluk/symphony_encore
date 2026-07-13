import type { FastifyInstance } from "fastify";

import { registerOperatorUi } from "./operator-ui.js";

export interface HttpRuntimeInput {
  host: string;
  listen?: (options: { host: string; port: number }) => Promise<string>;
  output?: (line: string) => void;
  port: number;
  server: FastifyInstance;
  uiRoot: string;
}

export async function startHttpRuntime(input: HttpRuntimeInput) {
  await registerOperatorUi(input.server, { root: input.uiRoot });
  await input.server.ready();
  const url = await (input.listen ?? ((options) => input.server.listen(options)))({
    host: input.host,
    port: input.port,
  });
  (input.output ?? ((line) => process.stdout.write(`${line}\n`)))(`Symphony Encore UI: ${url}`);

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await input.server.close();
    },
    url,
  };
}
