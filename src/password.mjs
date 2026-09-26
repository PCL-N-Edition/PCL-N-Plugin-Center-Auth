import { scrypt, randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) throw new Error('密码长度必须为 14–256 字符');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, options);
  return `${salt}:${key.toString('hex')}`;
}
const dummy = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
export async function verifyPassword(password, hash = dummy) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, encoded] = hash.split(':');
  const expected = Buffer.from(encoded, 'hex');
  const key = await derive(password, salt, 64, options);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
