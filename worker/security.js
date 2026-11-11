// Stateless crypto helpers for Cloudflare Workers and Node. Never log credentials.
const encoder = new TextEncoder();
export const isoNow = () => new Date().toISOString();
export const randomToken = (bytes = 32) => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, n => n.toString(16).padStart(2, '0')).join('');
};
export const hashString = async value => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
};
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
// Cloudflare Workers WebCrypto rejects PBKDF2 iterations greater than 100000.
// D1 password_credentials enforces >=100000, so use this exact supported bound.
const ITERATIONS = 100000;
export function validatePassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}
export async function newCredential(password) {
  if (!validatePassword(password)) throw new Error('PASSWORD_LENGTH');
  const salt = randomToken(16);
  return { password_salt: salt, password_hash: await pbkdf2(password, salt, ITERATIONS), iterations: ITERATIONS };
}
export async function pbkdf2(password, saltHex, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(x => parseInt(x, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, 256);
  return Array.from(new Uint8Array(bits), n => n.toString(16).padStart(2, '0')).join('');
}
export async function checkPassword(password, credentials) {
  if (!credentials || !validatePassword(password)) return false;
  const candidate = await pbkdf2(password, credentials.password_salt, credentials.iterations);
  return safeEqual(candidate, credentials.password_hash);
}
export function parseCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  return cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}
export function cookieForSession(value, maxAge = 60 * 60 * 24 * 14) {
  return `__Host-da_session=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
export function clearingCookie() { return cookieForSession('', 0); }
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  return origin === new URL(request.url).origin;
}
export function normalizedEmail(v) {
  if (typeof v !== 'string') return null;
  const email = v.trim().toLowerCase();
  return /^[^\s@]{1,80}@[^\s@]{1,140}\.[^\s@]{2,30}$/.test(email) ? email : null;
}
