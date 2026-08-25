module.exports = {
  // Backend VPS (2.25.117.230), reachable through the free nip.io wildcard
  // domain so Caddy can obtain a real Let's Encrypt certificate without
  // owning a domain. Must stay https:// — plain http would send credentials
  // and tokens unencrypted.
  API_BASE_URL: process.env.EVA_API_URL || 'https://2.25.117.230.nip.io',
};
