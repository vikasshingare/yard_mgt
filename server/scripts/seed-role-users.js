require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const crypto = require('crypto');
const pool = require('../src/db');
const { hashPassword } = require('../src/auth');

const accounts = [
  ['System Administrator', 'system.admin@icd-yms.test'],
  ['ICD Operations Manager', 'operations.manager@icd-yms.test'],
  ['Gate Operator', 'gate.operator@icd-yms.test'],
  ['Yard Planner / Yard Controller', 'yard.controller@icd-yms.test'],
  ['Reach-Stacker Operator', 'reachstacker.operator@icd-yms.test'],
  ['Inspection / Security', 'inspection.security@icd-yms.test'],
  ['Billing / Finance', 'billing.finance@icd-yms.test'],
  ['Auditor / Management', 'auditor.management@icd-yms.test'],
  ['External Partner', 'external.partner@icd-yms.test'],
];

function temporaryPassword() {
  // 18 random bytes provide 144 bits of entropy; delimiters make the credential
  // easier to read and still meet the application's 12-character minimum.
  const value = crypto.randomBytes(18).toString('base64url');
  return `${value.slice(0, 8)}-${value.slice(8, 16)}-${value.slice(16, 24)}!`;
}

async function main() {
  const connection = await pool.getConnection();
  const created = [];
  try {
    await connection.beginTransaction();
    const [roles] = await connection.query('SELECT role_name FROM roles');
    const available = new Set(roles.map(row => row.role_name));
    for (const [roleName] of accounts) {
      if (!available.has(roleName)) throw new Error(`Required role is missing: ${roleName}. Run npm run db:setup first.`);
    }

    for (const [roleName, email] of accounts) {
      const [[existing]] = await connection.query('SELECT id FROM users WHERE email=? FOR UPDATE', [email]);
      if (existing) continue;
      const password = temporaryPassword();
      const [result] = await connection.query(
        'INSERT INTO users (email,display_name,password_hash,role_name,must_change_password) VALUES (?,?,?,?,1)',
        [email, roleName, await hashPassword(password), roleName],
      );
      await connection.query(
        'INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,new_values) VALUES (?,?,?,?,?,?,?)',
        ['Local setup', 'System Administrator', 'USER_CREATED', 'AUTH', String(result.insertId), 'Role account created by local seed command', JSON.stringify({ email, role_name: roleName })],
      );
      created.push({ roleName, email, password });
    }
    await connection.commit();

    if (!created.length) {
      process.stdout.write('All nine role accounts already exist; no passwords were changed.\n');
      return;
    }
    process.stdout.write('Created role accounts. Save these temporary passwords now; they are not stored in plaintext.\n');
    process.stdout.write('Each account must change its password at first sign-in.\n\n');
    for (const account of created) {
      process.stdout.write(`${account.roleName}\n  Email: ${account.email}\n  Temporary password: ${account.password}\n\n`);
    }
    const skipped = accounts.length - created.length;
    if (skipped) process.stdout.write(`${skipped} account(s) already existed and were left unchanged. Use the password reset workflow for those accounts.\n`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

main().catch(error => {
  process.stderr.write(`Could not seed role accounts: ${error.code === 'ER_DUP_ENTRY' ? 'an account email already exists' : error.message}\n`);
  process.exitCode = 1;
}).finally(() => pool.end());
