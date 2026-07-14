import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code !== "ERR_MODULE_NOT_FOUND" ||
        !specifier.startsWith(".") ||
        !specifier.endsWith(".js") ||
        context.parentURL === undefined ||
        !context.parentURL.startsWith("file:")
      ) {
        throw error;
      }

      const sourceUrl = new URL(specifier.replace(/\.js$/u, ".ts"), context.parentURL);
      if (!existsSync(fileURLToPath(sourceUrl))) throw error;
      return { shortCircuit: true, url: sourceUrl.href };
    }
  },
});
