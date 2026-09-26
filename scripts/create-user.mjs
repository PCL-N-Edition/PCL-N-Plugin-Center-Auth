import { hashPassword } from '../src/password.mjs';
import { writeFile } from 'node:fs/promises';
const [name, output, role] = process.argv.slice(2);
if (!name || !/^[\p{L}\p{N}_.@-]{3,80}$/u.test(name) || !output || (role && role !== 'staff')) throw new Error('Usage: node scripts/create-user.mjs NAME OUTPUT.sql [staff]; password from NEXA_INITIAL_PASSWORD');
const hash = await hashPassword(process.env.NEXA_INITIAL_PASSWORD);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
await writeFile(output, `INSERT INTO users(id,name,password_hash,staff) VALUES(${quote(crypto.randomUUID())},${quote(name)},${quote(hash)},${role === 'staff' ? 1 : 0});\n`, { flag: 'wx', mode: 0o600 });
console.log('Provisioning SQL written. Apply to the intended Auth D1 database; do not commit it.');
