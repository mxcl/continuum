import { pool, runSchemaMigration } from "../db";

async function main(): Promise<void> {
  await runSchemaMigration();
  console.log("Schema migration completed.");
}

main()
  .catch((error) => {
    console.error("Migration failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });

