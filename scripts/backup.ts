import Database from "better-sqlite3";
import { join } from "node:path";
import { dataDir } from "../src/server/config.js";
const database = new Database(join(dataDir, "flowcanvas.db"), {
  readonly: true,
  fileMustExist: true,
});
const destination = join(
  dataDir,
  `flowcanvas-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`,
);
try {
  await database.backup(destination);
  console.log(`Backup saved: ${destination}`);
} finally {
  database.close();
}
