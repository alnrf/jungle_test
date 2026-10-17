import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import type { Env } from "../../config/env";
import { Migration20261012000000_initial } from "./migrations/Migration20261012000000_initial";
import { ALL_SCHEMAS } from "./schemas";

export function buildOrmConfig(env: Pick<Env, "DATABASE_URL" | "DB_POOL_MAX">): Options {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    entities: ALL_SCHEMAS,
    // sem discovery por glob: o bun não precisa varrer diretório nenhum
    discovery: { warnWhenNoEntities: false },
    pool: { min: 1, max: env.DB_POOL_MAX },
    // timestamptz sempre em UTC
    forceUtcTimezone: true,
    debug: false,
    allowGlobalContext: false,
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        { name: "Migration20261012000000_initial", class: Migration20261012000000_initial },
      ],
    },
  });
}
