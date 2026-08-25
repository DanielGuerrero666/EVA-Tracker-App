const crypto = require('crypto');

// Excludes visually ambiguous characters (0/O, 1/l/I) since this gets read
// aloud or typed by hand when an admin relays it to a new employee.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateTempPassword(length = 12) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

module.exports = { generateTempPassword };
