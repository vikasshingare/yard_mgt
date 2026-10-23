const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const { execFileSync } = require('child_process');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
    await connection.query(sql);
    console.log('Database icd_yms created and base data loaded.');
  } finally { await connection.end(); }
  execFileSync(process.execPath, [path.join(__dirname,'migrate-workflows.js')], { stdio:'inherit', env:process.env });
}
main().catch(error => { console.error('Database setup failed:', error.message); process.exitCode = 1; });
