import { pathToFileURL } from "node:url";

import { openDatabase } from "@symphony/persistence";

interface ServiceRunSmokeRow {
  end_reason: unknown;
  status: unknown;
}

export interface ContainerRestartState {
  serviceRunCount: number;
}

function safeError(message: string): Error {
  return new Error(message);
}

export async function verifyContainerRestartState(
  databasePath: string,
): Promise<ContainerRestartState> {
  let opened: ReturnType<typeof openDatabase>;
  try {
    opened = openDatabase(databasePath);
  } catch {
    throw safeError("container_smoke.database_open_failed");
  }

  let failure: Error | undefined;
  let result: ContainerRestartState | undefined;
  try {
    let rows: ServiceRunSmokeRow[];
    try {
      rows = opened.sqlite
        .prepare("select status, end_reason from service_runs order by started_at, id")
        .all() as ServiceRunSmokeRow[];
    } catch {
      throw safeError("container_smoke.service_runs_query_failed");
    }

    if (rows.length !== 2) {
      throw safeError(`container_smoke.service_run_count:expected=2:actual=${rows.length}`);
    }
    if (rows.some((row) => row.status !== "stopped")) {
      throw safeError("container_smoke.service_run_status:expected=stopped");
    }
    if (rows.some((row) => row.end_reason !== "signal")) {
      throw safeError("container_smoke.service_run_end_reason:expected=signal");
    }

    result = { serviceRunCount: rows.length };
  } catch (error) {
    failure =
      error instanceof Error && error.message.startsWith("container_smoke.")
        ? error
        : safeError("container_smoke.unexpected_failure");
  }

  try {
    await opened.close();
  } catch {
    failure ??= safeError("container_smoke.database_close_failed");
  }

  if (failure !== undefined) throw failure;
  if (result === undefined) throw safeError("container_smoke.unexpected_failure");
  return result;
}

export async function runContainerSmoke(
  argv: readonly string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const databasePath = argv[2] ?? environment.SYMPHONY_DATABASE_PATH;
  if (databasePath === undefined || databasePath.trim() === "") {
    process.stderr.write("container_smoke.database_path_required\n");
    return 1;
  }

  try {
    const result = await verifyContainerRestartState(databasePath);
    process.stdout.write(`container_smoke.passed:service_runs=${result.serviceRunCount}\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith("container_smoke.")
        ? error.message
        : "container_smoke.unexpected_failure";
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runContainerSmoke();
}
