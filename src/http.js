const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => fn(req, res).catch(next);

const num = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < min || n > max)
    throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};
const str = (v, name, max) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new HttpError(400, `${name} is required (max ${max} chars)`);
  return v.trim();
};

// Compare secrets in constant time regardless of length (hash first so the buffers match in size).
const sameSecret = (a, b) => {
  const h = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

module.exports = { HttpError, wrap, num, str, sameSecret };
