const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const serverHome = path.resolve(__dirname, '..');
const workspace = path.resolve(serverHome, '..');
const dataDir = path.join(workspace, 'mysql-data');
const mysqlHome = process.env.MYSQL_HOME || 'C:\\Program Files\\MySQL\\MySQL Server 8.4';
const mysqld = path.join(mysqlHome, 'bin', 'mysqld.exe');
const envPath = path.join(serverHome, '.env');
const port = 3307;

function getSavedPassword() {
  if (!fs.existsSync(envPath)) return '';
  const match = fs.readFileSync(envPath, 'utf8').match(/^DB_PASSWORD=(.*)$/m);
  return match ? match[1].trim() : '';
}
function getSavedJwtSecret() {
  if (!fs.existsSync(envPath)) return '';
  const match = fs.readFileSync(envPath, 'utf8').match(/^JWT_SECRET=(.*)$/m);
  return match ? match[1].trim() : '';
}
function writeLocalEnv(password, jwtSecret) {
  fs.writeFileSync(envPath, `PORT=4000\nDB_HOST=localhost\nDB_PORT=${port}\nDB_USER=root\nDB_PASSWORD=${password}\nDB_NAME=icd_yms\nJWT_SECRET=${jwtSecret}\n`, {encoding:'utf8',mode:0o600});
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(password) {
  return mysql.createConnection({host:'127.0.0.1',port,user:'root',password,connectTimeout:1500,multipleStatements:true});
}

async function main() {
  if (!fs.existsSync(mysqld)) throw new Error(`MySQL Server binary not found at ${mysqld}. Install MySQL Server 8.4 first.`);
  const systemTable = path.join(dataDir,'mysql.ibd');
  if (!fs.existsSync(systemTable)) {
    fs.mkdirSync(dataDir,{recursive:true});
    const init = spawnSync(mysqld,['--initialize-insecure',`--basedir=${mysqlHome}`,`--datadir=${dataDir}`],{stdio:'inherit',windowsHide:true});
    if (init.status !== 0) throw new Error('Could not initialize the new MySQL data directory.');
  }

  let password=getSavedPassword();
  let jwtSecret=getSavedJwtSecret();
  let connection;
  try { connection=await connect(password); }
  catch {
    const args=[`--basedir=${mysqlHome}`,`--datadir=${dataDir}`,`--port=${port}`,'--bind-address=127.0.0.1','--mysqlx=0',`--log-error=${path.join(dataDir,'mysql-error.log')}`];
    const child=spawn(mysqld,args,{detached:true,windowsHide:true,stdio:'ignore'});
    child.unref();
    for(let attempt=0;attempt<40;attempt++){
      await sleep(1000);
      try { connection=await connect(password); break; } catch {}
    }
  }
  if(!connection) throw new Error(`MySQL did not start on localhost:${port}. See .mysql-yms-data/mysql-error.log.`);

  if(!password){
    password=crypto.randomBytes(24).toString('base64url');
    jwtSecret=jwtSecret || crypto.randomBytes(48).toString('base64url');
    await connection.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}'`);
    await connection.end();
    writeLocalEnv(password,jwtSecret);
    connection=await connect(password);
  } else if(!jwtSecret) {
    jwtSecret=crypto.randomBytes(48).toString('base64url');
    fs.appendFileSync(envPath,`JWT_SECRET=${jwtSecret}\n`,{encoding:'utf8',mode:0o600});
  } else if(!fs.existsSync(envPath)) writeLocalEnv(password,jwtSecret);

  const schema=fs.readFileSync(path.join(serverHome,'database','schema.sql'),'utf8');
  await connection.query(schema);
  await connection.end();
  if(!fs.existsSync(envPath)) writeLocalEnv(password,jwtSecret);
  console.log(`MySQL 8.4 is ready on localhost:${port}; database icd_yms is created and seeded.`);
}
main().catch(error=>{console.error('Local MySQL setup failed:',error.message);process.exitCode=1;});
