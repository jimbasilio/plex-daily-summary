# Plex Daily Summary

Read-only TypeScript command that prints the local Plex DVR schedule for a selected day.

It reads the Plex token from the protected credential file at
`~/.config/openclaw/plex-token`; the token is never stored in this repository.

```bash
npm install
npm run build
npm run summary
```
