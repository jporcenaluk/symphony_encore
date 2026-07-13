import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  checkGeneratedContractSchemas,
  renderContractSchemas,
} from "./generate-contract-schemas.ts";

test("renders the public contract catalog deterministically", () => {
  const first = renderContractSchemas();
  const second = renderContractSchemas();

  assert.equal(first, second);
  const document = JSON.parse(first) as {
    $schema: string;
    schemas: Record<string, unknown>;
  };
  assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert("Attempt" in document.schemas);
  assert("ControlState" in document.schemas);
  assert("ErrorEnvelope" in document.schemas);
  assert("EventRecord" in document.schemas);
  assert("ImplementationOutcome" in document.schemas);
  assert("VerificationRecord" in document.schemas);
  assert.deepEqual(Object.keys(document.schemas), Object.keys(document.schemas).toSorted());
});

test("reports generated-contract drift", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "symphony-contracts-"));
  const target = path.join(directory, "contracts.schema.json");
  await writeFile(target, "{}\n", "utf8");

  assert.equal(await checkGeneratedContractSchemas(target), false);
  await writeFile(target, renderContractSchemas(), "utf8");
  assert.equal(await checkGeneratedContractSchemas(target), true);
});
