import { runTraceabilityStatusCli } from "./traceability-status.js";

process.exitCode = await runTraceabilityStatusCli(process.argv.slice(2));
