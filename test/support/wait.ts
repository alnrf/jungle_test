export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repete `check` até devolver algo truthy ou estourar o tempo. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  { timeoutMs = 15_000, intervalMs = 100, message = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${message}${last ? `: ${String(last)}` : ""}`);
}
