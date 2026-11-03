import { createRequire } from "node:module";

// Historical upstream deployment. Exit before loading pg or accessing roles.
console.error("WorkLoom PMtest: inherited Linux deployment is disabled; use the source setup in README.md.");
process.exit(78);

const requireFromRelease = createRequire(new URL("../../package.json", import.meta.url));
const pg = requireFromRelease("pg");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}。`);
  return value;
}

const database = process.env.WORKLOOM_DB_NAME?.trim() || "workloom_pm";
if (!/^[a-z][a-z0-9_]{2,62}$/.test(database)) throw new Error("WORKLOOM_DB_NAME 无效。");
const ownerPassword = required("WORKLOOM_OWNER_PASSWORD");
const appPassword = required("APP_DB_PASSWORD");
const gatewayPassword = required("GATEWAY_DB_PASSWORD");

const client = new pg.Client({
  host: process.env.WORKLOOM_PG_SOCKET || "/var/run/postgresql",
  port: Number(process.env.WORKLOOM_PG_PORT || 5432),
  database: "postgres",
  user: process.env.WORKLOOM_PG_ADMIN_USER || "postgres",
});
await client.connect();
try {
  for (const [role, password] of [
    ["workloom_owner", ownerPassword],
    ["workloom_app", appPassword],
    ["workloom_gateway", gatewayPassword],
  ]) {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role]);
    const formatted = await client.query("SELECT format($1::text, $2::text, $3::text) AS sql", [
      exists.rowCount
        ? "ALTER ROLE %I LOGIN PASSWORD %L"
        : "CREATE ROLE %I LOGIN PASSWORD %L",
      role,
      password,
    ]);
    await client.query(formatted.rows[0].sql);
  }
  await client.query("ALTER ROLE workloom_owner BYPASSRLS");
  const databaseExists = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]);
  if (!databaseExists.rowCount) {
    const formatted = await client.query("SELECT format('CREATE DATABASE %I OWNER workloom_owner', $1::text) AS sql", [database]);
    await client.query(formatted.rows[0].sql);
  }
  const databaseClient = new pg.Client({
    host: process.env.WORKLOOM_PG_SOCKET || "/var/run/postgresql",
    port: Number(process.env.WORKLOOM_PG_PORT || 5432),
    database,
    user: process.env.WORKLOOM_PG_ADMIN_USER || "postgres",
  });
  await databaseClient.connect();
  try {
    await databaseClient.query("CREATE EXTENSION IF NOT EXISTS vector");
    await databaseClient.query("GRANT USAGE ON SCHEMA public TO workloom_owner, workloom_app, workloom_gateway");
    await databaseClient.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO workloom_owner");
    await databaseClient.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO workloom_owner");
    const adminUser = process.env.WORKLOOM_PG_ADMIN_USER || "postgres";
    const defaultTables = await databaseClient.query("SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workloom_owner', $1::text) AS sql", [adminUser]);
    const defaultSequences = await databaseClient.query("SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO workloom_owner', $1::text) AS sql", [adminUser]);
    await databaseClient.query(defaultTables.rows[0].sql);
    await databaseClient.query(defaultSequences.rows[0].sql);
  } finally {
    await databaseClient.end();
  }
  console.log("database owner and database are ready");
} finally {
  await client.end();
}
