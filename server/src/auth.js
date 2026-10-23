const crypto = require('crypto');
const { promisify } = require('util');
const pool = require('./db');

const scrypt = promisify(crypto.scrypt);
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 14;
const PASSWORD_RESET_TTL_MINUTES = 30;
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be configured as a random secret of at least 32 characters.');

function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = encoded.split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
function signAccessToken(user, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: String(user.id), sid: sessionId, iat: now, exp: now + ACCESS_TTL_SECONDS, iss: 'icd-yms' })).toString('base64url');
  const input = `${head}.${body}`;
  return `${input}.${crypto.createHmac('sha256', jwtSecret).update(input).digest('base64url')}`;
}
function verifyAccessToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const input = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', jwtSecret).update(input).digest();
  let signature;
  try { signature = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims.iss !== 'icd-yms' || !claims.sub || !claims.sid || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}
function clientMetadata(req) {
  return { ip: req.ip || null, userAgent: String(req.get('user-agent') || '').slice(0, 500) || null };
}
async function writeSecurityAudit(connection, actor, action, entityId, reason, oldValues, newValues) {
  await connection.query(`INSERT INTO audit_log (actor,role_name,action,entity_type,entity_id,reason,old_values,new_values) VALUES (?,?,?,?,?,?,?,?)`, [actor || 'Unauthenticated', 'Security', action, 'AUTH', entityId == null ? null : String(entityId), reason || null, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]);
}

async function logAttempt(connection, userId, email, succeeded, metadata, failureReason) {
  await connection.query(`INSERT INTO login_history (user_id,email_attempted,succeeded,ip_address,user_agent,failure_reason) VALUES (?,?,?,?,?,?)`, [userId || null, email, succeeded ? 1 : 0, metadata.ip, metadata.userAgent, failureReason || null]);
}

function installAuth(app, express) {
  app.post('/api/auth/login', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const metadata = clientMetadata(req);
    if (!email || !password || email.length > 254 || password.length > 1024) return res.status(400).json({ error: 'Enter a valid email address and password.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[rate]] = await connection.query(`SELECT COUNT(*) AS attempts FROM login_history WHERE ip_address=? AND succeeded=0 AND created_at>=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 15 MINUTE)`, [metadata.ip]);
      if (Number(rate.attempts) >= 30) { await connection.commit(); return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes and try again.' }); }
      const [[user]] = await connection.query('SELECT id,email,display_name,password_hash,role_name,is_active,must_change_password,failed_login_count,(locked_until>UTC_TIMESTAMP()) AS currently_locked FROM users WHERE email=? FOR UPDATE', [email]);
      const locked = Number(user?.currently_locked) === 1;
      const valid = !!user && !!user.is_active && !locked && await verifyPassword(password, user.password_hash);
      if (!valid) {
        const reason = !user ? 'UNKNOWN_ACCOUNT' : !user.is_active ? 'INACTIVE_ACCOUNT' : locked ? 'LOCKED_ACCOUNT' : 'INVALID_PASSWORD';
        if (user && user.is_active) {
          const failed = Number(user.failed_login_count) + 1;
          await connection.query('UPDATE users SET failed_login_count=?,locked_until=IF(? >= 5,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE),locked_until) WHERE id=?', [failed, failed, user.id]);
        }
        await logAttempt(connection, user?.id, email, false, metadata, reason);
        await writeSecurityAudit(connection, email, 'LOGIN_FAILED', user?.id, reason, null, { email });
        await connection.commit();
        return res.status(401).json({ error: 'Email or password is incorrect, or the account is unavailable.' });
      }
      const sessionId = crypto.randomUUID();
      const refreshToken = crypto.randomBytes(48).toString('base64url');
      await connection.query('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=UTC_TIMESTAMP() WHERE id=?', [user.id]);
      await connection.query('INSERT INTO auth_sessions (id,user_id,refresh_token_hash,expires_at,ip_address,user_agent) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? DAY),?,?)', [sessionId, user.id, tokenHash(refreshToken), REFRESH_TTL_DAYS, metadata.ip, metadata.userAgent]);
      await logAttempt(connection, user.id, email, true, metadata, null);
      await writeSecurityAudit(connection, email, 'LOGIN_SUCCESS', user.id, null, null, { session_id: sessionId, role_name: user.role_name });
      const [permissionRows] = await connection.query('SELECT permission_code FROM role_permissions WHERE role_name=?', [user.role_name]);
      await connection.commit();
      return res.json({ access_token: signAccessToken(user, sessionId), refresh_token: refreshToken, expires_in: ACCESS_TTL_SECONDS, user: { id: user.id, email: user.email, display_name: user.display_name, role_name: user.role_name, permissions: permissionRows.map(x => x.permission_code), must_change_password: !!user.must_change_password } });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.post('/api/auth/refresh', async (req, res, next) => {
    const token = String(req.body.refresh_token || '');
    if (!token) return res.status(400).json({ error: 'Refresh token is required.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[session]] = await connection.query(`SELECT s.*,u.email,u.display_name,u.role_name,u.is_active,u.must_change_password FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.refresh_token_hash=? AND s.expires_at>UTC_TIMESTAMP() FOR UPDATE`, [tokenHash(token)]);
      if (session?.revoked_at && session.replaced_by_session_id) {
        await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE id=? AND revoked_at IS NULL', [session.replaced_by_session_id]);
      }
      if (!session || session.revoked_at || !session.is_active) {
        if (session && !session.revoked_at) await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE id=?', [session.id]);
        await connection.commit();
        return res.status(401).json({ error: 'Session expired. Please sign in again.' });
      }
      const nextId = crypto.randomUUID();
      const nextRefresh = crypto.randomBytes(48).toString('base64url');
      await connection.query('INSERT INTO auth_sessions (id,user_id,refresh_token_hash,expires_at,ip_address,user_agent) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? DAY),?,?)', [nextId, session.user_id, tokenHash(nextRefresh), REFRESH_TTL_DAYS, req.ip || null, String(req.get('user-agent') || '').slice(0, 500)]);
      await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP(),replaced_by_session_id=?,last_used_at=UTC_TIMESTAMP() WHERE id=?', [nextId, session.id]);
      const [permissionRows] = await connection.query('SELECT permission_code FROM role_permissions WHERE role_name=?', [session.role_name]);
      await connection.commit();
      return res.json({ access_token: signAccessToken({ id: session.user_id }, nextId), refresh_token: nextRefresh, expires_in: ACCESS_TTL_SECONDS, user: { id: session.user_id, email: session.email, display_name: session.display_name, role_name: session.role_name, permissions: permissionRows.map(x => x.permission_code), must_change_password: !!session.must_change_password } });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.post('/api/auth/password-reset/request', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    try {
      const [[user]] = await pool.query('SELECT id,email FROM users WHERE email=? AND is_active=1', [email]);
      if (user) {
        await pool.query('UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP() WHERE user_id=? AND used_at IS NULL', [user.id]);
        const resetToken = crypto.randomBytes(32).toString('base64url');
        await pool.query('INSERT INTO password_reset_tokens (user_id,token_hash,expires_at,requested_ip) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),?)', [user.id, tokenHash(resetToken), PASSWORD_RESET_TTL_MINUTES, req.ip || null]);
        if (process.env.NODE_ENV !== 'production') console.info(`Development password reset token for ${email}: ${resetToken}`);
        const c = await pool.getConnection();
        try { await writeSecurityAudit(c, email, 'PASSWORD_RESET_REQUEST', user.id, null, null, null); } finally { c.release(); }
      }
      return res.json({ message: 'If the account is eligible, reset instructions will be delivered shortly.' });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/password-reset/complete', async (req, res, next) => {
    const token = String(req.body.token || '');
    const password = String(req.body.new_password || '');
    if (password.length < 12 || password.length > 1024) return res.status(400).json({ error: 'New password must be at least 12 characters.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[reset]] = await connection.query('SELECT r.*,u.email FROM password_reset_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.expires_at>UTC_TIMESTAMP() FOR UPDATE', [tokenHash(token)]);
      if (!reset || reset.used_at) { await connection.rollback(); return res.status(400).json({ error: 'Reset token is invalid or expired.' }); }
      const passwordHash = await hashPassword(password);
      await connection.query('UPDATE users SET password_hash=?,must_change_password=0,failed_login_count=0,locked_until=NULL WHERE id=?', [passwordHash, reset.user_id]);
      await connection.query('UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP() WHERE id=?', [reset.id]);
      await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND revoked_at IS NULL', [reset.user_id]);
      await writeSecurityAudit(connection, reset.email, 'PASSWORD_RESET_COMPLETE', reset.user_id, null, null, null);
      await connection.commit();
      return res.json({ message: 'Password reset. Sign in with your new password.' });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.use('/api', requireAuth);
  app.post('/api/auth/logout', async (req, res, next) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE id=? AND revoked_at IS NULL', [req.user.sessionId]);
      await writeSecurityAudit(connection, req.user.email, 'LOGOUT', req.user.id, null, null, { session_id: req.user.sessionId });
      await connection.commit();
      res.json({ status: 'logged_out' });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/password/change', async (req, res, next) => {
    const currentPassword = String(req.body.current_password || '');
    const nextPassword = String(req.body.new_password || '');
    if (nextPassword.length < 12 || nextPassword.length > 1024) return res.status(400).json({ error: 'New password must be at least 12 characters.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[user]] = await connection.query('SELECT password_hash FROM users WHERE id=? FOR UPDATE', [req.user.id]);
      if (!user || !(await verifyPassword(currentPassword, user.password_hash))) { await connection.rollback(); return res.status(401).json({ error: 'Current password is incorrect.' }); }
      await connection.query('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', [await hashPassword(nextPassword), req.user.id]);
      await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND id<>? AND revoked_at IS NULL', [req.user.id, req.user.sessionId]);
      await writeSecurityAudit(connection, req.user.email, 'PASSWORD_CHANGE', req.user.id, null, null, null);
      await connection.commit();
      res.json({ status: 'password_changed' });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.get('/api/admin/roles', requirePermission('roles:manage'), async (_req, res, next) => {
    try {
      const [roles] = await pool.query('SELECT role_name,description FROM roles ORDER BY role_name');
      const [permissions] = await pool.query('SELECT role_name,permission_code FROM role_permissions ORDER BY role_name,permission_code');
      res.json(roles.map(role => ({ ...role, permissions: permissions.filter(p => p.role_name === role.role_name).map(p => p.permission_code) })));
    } catch (error) { next(error); }
  });

  app.get('/api/admin/permissions', requirePermission('roles:manage'), async (_req, res, next) => {
    try { const [rows] = await pool.query('SELECT permission_code,description FROM permissions ORDER BY permission_code'); res.json(rows); }
    catch (error) { next(error); }
  });

  app.put('/api/admin/roles/:role/permissions', requirePermission('roles:manage'), async (req, res, next) => {
    const list = req.body.permissions;
    if (!Array.isArray(list) || list.some(x => typeof x !== 'string')) return res.status(400).json({ error: 'permissions must be an array of permission codes.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[role]] = await connection.query('SELECT role_name FROM roles WHERE role_name=? FOR UPDATE', [req.params.role]);
      if (!role) { await connection.rollback(); return res.status(404).json({ error: 'Role not found.' }); }
      const [known] = await connection.query('SELECT permission_code FROM permissions WHERE permission_code IN (?)', [list.length ? list : ['__none__']]);
      if (known.length !== list.length) { await connection.rollback(); return res.status(400).json({ error: 'One or more permission codes are unknown.' }); }
      await connection.query('DELETE FROM role_permissions WHERE role_name=?', [role.role_name]);
      if (role.role_name === 'System Administrator' && !['users:manage','roles:manage','system:manage'].every(code => list.includes(code))) { await connection.rollback(); return res.status(409).json({ error: 'The System Administrator role must retain account, role and system management permissions.' }); }
      if (list.length) await connection.query('INSERT INTO role_permissions (role_name,permission_code) VALUES ?', [list.map(code => [role.role_name, code])]);
      await writeSecurityAudit(connection, req.user.email, 'ROLE_PERMISSIONS_CHANGED', role.role_name, null, null, { permissions: list });
      await connection.commit();
      res.json({ role_name: role.role_name, permissions: list });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.get('/api/admin/users', requirePermission('users:manage'), async (_req, res, next) => {
    try { const [rows] = await pool.query('SELECT id,email,display_name,role_name,is_active,must_change_password,last_login_at,created_at FROM users ORDER BY display_name LIMIT 500'); res.json(rows); }
    catch (error) { next(error); }
  });

  app.post('/api/admin/users', requirePermission('users:manage'), async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const displayName = String(req.body.display_name || '').trim();
    const roleName = String(req.body.role_name || '').trim();
    const password = String(req.body.temporary_password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName || displayName.length > 120 || password.length < 12 || password.length > 1024) return res.status(400).json({ error: 'Provide a valid email, display name, role and temporary password of at least 12 characters.' });
    try {
      const [result] = await pool.query('INSERT INTO users (email,display_name,password_hash,role_name,must_change_password) SELECT ?,?,?,?,1 WHERE EXISTS (SELECT 1 FROM roles WHERE role_name=?)', [email, displayName, await hashPassword(password), roleName, roleName]);
      if (!result.affectedRows) return res.status(400).json({ error: 'Role not found.' });
      const c = await pool.getConnection();
      try { await writeSecurityAudit(c, req.user.email, 'USER_CREATED', result.insertId, null, null, { email, role_name: roleName }); } finally { c.release(); }
      res.status(201).json({ id: result.insertId, email, display_name: displayName, role_name: roleName, must_change_password: true });
    } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'An account with that email already exists.' }); next(error); }
  });

  app.patch('/api/admin/users/:id/status', requirePermission('users:manage'), async (req, res, next) => {
    const active = req.body.is_active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false.' });
    if (Number(req.params.id) === Number(req.user.id) && !active) return res.status(409).json({ error: 'You cannot deactivate your own account.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[target]] = await connection.query('SELECT id,role_name,is_active FROM users WHERE id=? FOR UPDATE', [req.params.id]);
      if (!target) { await connection.rollback(); return res.status(404).json({ error: 'User not found.' }); }
      if (!active && target.is_active && target.role_name === 'System Administrator') {
        const [others] = await connection.query("SELECT id FROM users WHERE role_name='System Administrator' AND is_active=1 AND id<>? FOR UPDATE", [target.id]);
        if (!others.length) { await connection.rollback(); return res.status(409).json({ error: 'The last active System Administrator cannot be deactivated.' }); }
      }
      await connection.query('UPDATE users SET is_active=? WHERE id=?', [active ? 1 : 0, req.params.id]);
      if (!active) await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND revoked_at IS NULL', [req.params.id]);
      await writeSecurityAudit(connection, req.user.email, active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', req.params.id, null, null, { is_active: active });
      await connection.commit();
      res.json({ id: Number(req.params.id), is_active: active });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.patch('/api/admin/users/:id/role', requirePermission('users:manage'), async (req, res, next) => {
    if (Number(req.params.id) === Number(req.user.id)) return res.status(409).json({ error: 'You cannot change your own role.' });
    const roleName = String(req.body.role_name || '').trim();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[user]] = await connection.query('SELECT id,role_name FROM users WHERE id=? FOR UPDATE', [req.params.id]);
      const [[role]] = await connection.query('SELECT role_name FROM roles WHERE role_name=?', [roleName]);
      if (!user || !role) { await connection.rollback(); return res.status(404).json({ error: 'User or role not found.' }); }
      if (user.role_name === 'System Administrator') {
        const [others] = await connection.query("SELECT id FROM users WHERE role_name='System Administrator' AND is_active=1 AND id<>? FOR UPDATE", [user.id]);
        if (!others.length) { await connection.rollback(); return res.status(409).json({ error: 'The last active System Administrator cannot be reassigned.' }); }
      }
      await connection.query('UPDATE users SET role_name=? WHERE id=?', [roleName, user.id]);
      await connection.query('UPDATE auth_sessions SET revoked_at=UTC_TIMESTAMP() WHERE user_id=? AND revoked_at IS NULL', [user.id]);
      await writeSecurityAudit(connection, req.user.email, 'USER_ROLE_CHANGED', user.id, null, { role_name: user.role_name }, { role_name: roleName });
      await connection.commit();
      res.json({ id: user.id, role_name: roleName });
    } catch (error) { await connection.rollback(); next(error); }
    finally { connection.release(); }
  });

  app.get('/api/admin/login-history', requirePermission('users:manage'), async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const [rows] = await pool.query('SELECT id,user_id,email_attempted,succeeded,ip_address,user_agent,failure_reason,created_at FROM login_history ORDER BY created_at DESC LIMIT ?', [limit]);
      res.json(rows);
    } catch (error) { next(error); }
  });
}

function requireAuth(req, res, next) {
  const bearer = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  const claims = bearer && verifyAccessToken(bearer[1]);
  if (!claims) return res.status(401).json({ error: 'Sign in is required or your access token has expired.' });
  pool.query(`SELECT u.id,u.email,u.display_name,u.role_name,u.must_change_password,s.id AS session_id FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=? AND s.id=? AND u.is_active=1 AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP()`, [claims.sub, claims.sid])
    .then(async ([rows]) => {
      const user = rows[0];
      if (!user) return res.status(401).json({ error: 'Session expired or account disabled. Sign in again.' });
      if (user.must_change_password && !['/api/auth/password/change','/api/auth/logout','/api/auth/me'].includes(req.originalUrl.split('?')[0])) return res.status(403).json({ error: 'Change your temporary password before using the system.', code: 'PASSWORD_CHANGE_REQUIRED' });
      const [permissionRows] = await pool.query('SELECT permission_code FROM role_permissions WHERE role_name=?', [user.role_name]);
      req.user = { id: user.id, email: user.email, display_name: user.display_name, role_name: user.role_name, permissions: permissionRows.map(x => x.permission_code), must_change_password: !!user.must_change_password, sessionId: user.session_id };
      next();
    })
    .catch(next);
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in is required.' });
    if (!req.user.permissions.includes(permission)) return res.status(403).json({ error: 'Your role does not have permission to perform this action.', required_permission: permission });
    next();
  };
}

module.exports = { installAuth, requireAuth, requirePermission, hashPassword, verifyPassword };
