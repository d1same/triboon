# Security Policy

## Supported Version

Security fixes are made against the current `main` branch and the latest public
release. Before reporting a problem, confirm it still occurs on the newest
version when doing so is safe.

## Report A Vulnerability Privately

Do **not** open a public issue for a suspected vulnerability or any report that
contains credentials, private provider URLs, tokens, personal media details, or
user data. Use [GitHub private vulnerability
reporting](https://github.com/d1same/triboon/security/advisories/new) instead.

Please include:

- the affected Triboon version or commit;
- the affected surface (server, web, Android, Windows, Docker, or Unraid);
- clear reproduction steps and the likely impact;
- only the minimum redacted evidence needed to understand the problem.

Never attach a Triboon `data/` directory, `.env` file, NZB, cookies export,
release keystore, database, complete server log, or screenshot containing an
API key, provider credential, signed stream URL, Trakt token, or personal media
name. Replace secrets with obvious placeholders such as `<redacted>`.

Non-sensitive bugs can use the normal [issue
tracker](https://github.com/d1same/triboon/issues).

## Deployment Boundary

Triboon's port `7777` serves plain HTTP. Complete first-run owner creation on a
trusted LAN before exposing the service, and use a trusted HTTPS reverse proxy
or VPN for remote access. Protect and back up the persistent `/data` directory:
application settings are encrypted, but that is not whole-volume encryption.
