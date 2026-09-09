import { timingSafeEqual } from 'node:crypto';

export function isLoopback(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address ?? '').toLowerCase());
}

function tokenMatches(supplied, expected) {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeApiRequest({ remoteAddress, bindHost, authorization, accessToken }) {
  if (isLoopback(remoteAddress)) return;
  if (bindHost === '127.0.0.1') throw Object.assign(new Error('Network API access is disabled.'), { statusCode: 403 });
  const header = String(authorization ?? '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!supplied || !tokenMatches(supplied, String(accessToken ?? ''))) {
    throw Object.assign(new Error('A valid Focusrite API access token is required.'), { statusCode: 401 });
  }
}
