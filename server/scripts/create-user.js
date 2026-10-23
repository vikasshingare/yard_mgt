require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const readline = require('readline');
const pool = require('../src/db');
const { hashPassword } = require('../src/auth');

function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); }));
}

function secret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return Promise.reject(new Error('Run this command in an interactive terminal to enter passwords securely.'));
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise(resolve => {
    let value = '';
    const onData = buffer => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.exit(130); }
        if (char === '\r' || char === '\n') { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdout.write('\n'); resolve(value); return; }
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const email = (await question('Email: ')).toLowerCase();
  const name = await question('Display name: ');
  const [roles] = await pool.query('SELECT role_name FROM roles ORDER BY role_name');
  roles.forEach((role, index) => process.stdout.write(`${index + 1}) ${role.role_name}\n`));
  const roleIndex = Number(await question('Role number: ')) - 1;
  const role = roles[roleIndex];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 120 || !role) throw new Error('Enter a valid email, name and listed role.');
  const password = await secret('Password (minimum 12 characters): ');
  const confirm = await secret('Confirm password: ');
  if (password.length < 12 || password.length > 1024 || password !== confirm) throw new Error('Passwords must match and contain at least 12 characters.');
  const [result] = await pool.query('INSERT INTO users (email,display_name,password_hash,role_name) VALUES (?,?,?,?)', [email, name, await hashPassword(password), role.role_name]);
  await pool.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,new_values) VALUES (?,?,?,?,?,?,?)`, [email, role.role_name, 'USER_CREATED', 'AUTH', String(result.insertId), 'Created from trusted local CLI', JSON.stringify({ email, role_name: role.role_name })]);
  process.stdout.write(`Created ${email} as ${role.role_name}.\n`);
}

main().catch(error => { process.stderr.write(`Could not create user: ${error.code === 'ER_DUP_ENTRY' ? 'email already exists' : error.message}\n`); process.exitCode = 1; }).finally(() => pool.end());
