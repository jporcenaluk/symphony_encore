import { runNormativeRegistryCli } from "./normative-registry.js";

process.exitCode = await runNormativeRegistryCli(process.argv.slice(2));
