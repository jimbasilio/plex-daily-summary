# Plex Daily Summary

Read-only TypeScript command that prints the Plex DVR schedule for a selected day.

## Configuration

Copy `.env.example` to `.env` and set the credential-file path for your Plex
installation:

```bash
cp .env.example .env
```

`PLEX_CREDENTIAL_FILE` points to a file containing only the Plex token. The
token itself is never stored in this repository or in `.env`. Keep that file
owner-readable only (for example, mode `0600`).

`PLEX_BASE_URL` and `PLEX_TIMEZONE` are optional; the defaults are local Plex
at `http://127.0.0.1:32400` and `America/New_York`.

```bash
npm install
npm run build
npm run summary
```

An explicit command-line flag can override the credential-file location when
needed:

```bash
npm run summary -- --credential-file /path/to/plex-token
```
