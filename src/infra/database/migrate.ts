import { MikroORM } from "@mikro-orm/postgresql";
import { loadEnv } from "../../config/env";
import { buildOrmConfig } from "./mikro-orm.config";

/**
 * bun run migration:up   -> aplica tudo que falta
 * bun run migration:down -> desfaz a última
 */
async function main(): Promise<void> {
  const direction = process.argv[2] ?? "up";
  const orm = await MikroORM.init(buildOrmConfig(loadEnv()));
  try {
    const migrator = orm.getMigrator();
    if (direction === "up") {
      const applied = await migrator.up();
      console.log(`migrations applied: ${applied.map((m) => m.name).join(", ") || "none"}`);
    } else if (direction === "down") {
      const reverted = await migrator.down();
      console.log(`migrations reverted: ${reverted.map((m) => m.name).join(", ") || "none"}`);
    } else {
      throw new Error(`unknown direction "${direction}" (use up|down)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
