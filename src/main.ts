import { createApp } from "./bootstrap";
import { loadEnv } from "./config/env";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await createApp({ env });
  // worker também escuta HTTP, só pro health/metrics
  await app.listen(env.PORT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
