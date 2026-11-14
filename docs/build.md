# How to build and verify

- Run the app: `npm start` (port 3000, in-memory data).
- Checks: `bash factory/checks.sh` (lint and tests). All must pass before a PR is reviewed.
- Tests use `node:test`; no dependencies. Write the failing test first.
- API: `GET /api/slots`, `POST /api/bookings {slot, name, email}`.
