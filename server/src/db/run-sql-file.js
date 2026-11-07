// Runs a .sql file against DATABASE_URL (from server/.env), so no psql install is needed.
//   node server/src/db/run-sql-file.js database/schema.sql
// The file is sent as one multi-statement query; schema.sql and seed.sql wrap
// themselves in BEGIN/COMMIT, so a failure leaves the database unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import pool from './pool.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node server/src/db/run-sql-file.js <path-to-file.sql>');
  process.exit(1);
}

const filePath = path.resolve(file);
let sql;
try {
  sql = await fs.readFile(filePath, 'utf8');
} catch (err) {
  console.error(`Cannot read ${filePath}: ${err.message}`);
  process.exit(1);
}

try {
  await pool.query(sql);
  console.log(`OK: ${file}`);
} catch (err) {
  console.error(`FAILED: ${file}`);
  console.error(`  ${err.message}`);
  if (err.detail) console.error(`  Detail: ${err.detail}`);
  if (err.hint) console.error(`  Hint: ${err.hint}`);
  if (err.where) console.error(`  Where: ${err.where}`);
  if (err.position) {
    const line = sql.slice(0, Number(err.position)).split('\n').length;
    console.error(`  Near line ${line} of ${file}`);
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
