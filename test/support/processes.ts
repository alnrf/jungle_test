import type { Subprocess } from "bun";
import { join } from "node:path";
import { Api } from "./api";
import { BASE_ENV } from "./env";
import { waitFor } from "./wait";

const ROOT = join(import.meta.dir, "..", "..");
let nextPort = 4100 + Math.floor(Math.random() * 500);

export interface Instance {
  name: string;
  port: number;
  api: Api;
  proc: Subprocess;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): Promise<number>;
}

/**
 * Sobe a aplicação como processo separado (instância de verdade, com pool de
 * conexões e workers próprios). É o que os testes de múltiplas instâncias usam.
 */
export async function spawnInstance(name: string, env: Record<string, string> = {}): Promise<Instance> {
  const port = nextPort++;
  // process.execPath em vez de "bun": no Windows "bun" pode ser um shim
  // (.cmd) e o kill mataria só o shim, deixando a aplicação rodando
  const proc = Bun.spawn([process.execPath, "run", "src/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...BASE_ENV,
      APP_ROLE: "all",
      PORT: String(port),
      INSTANCE_ID: name,
      DB_POOL_MAX: "10",
      ...env,
    },
    stdout: process.env.TEST_SHOW_LOGS ? "inherit" : "ignore",
    stderr: "inherit",
  });

  const api = new Api(`http://127.0.0.1:${port}`);
  await waitFor(
    async () => {
      if (proc.exitCode !== null) throw new Error(`${name} exited with ${proc.exitCode}`);
      const res = await fetch(`${api.baseUrl}/health/ready`);
      return res.ok;
    },
    { timeoutMs: 30_000, intervalMs: 200, message: `${name} ready` },
  );

  return {
    name,
    port,
    api,
    proc,
    exited: proc.exited,
    async kill(signal = "SIGKILL") {
      proc.kill(signal);
      return proc.exited;
    },
  };
}
