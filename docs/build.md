# How to build and verify

- Run the app: `npm start` (port 3000, in-memory data).
- Checks: `bash factory/checks.sh` (lint and tests). All must pass before a PR is reviewed.
- Tests use `node:test`; no dependencies. Write the failing test first.
- API: `GET /healthz` (liveness, `{"status":"ok"}`), `GET /api/slots`, `POST /api/bookings {slot, name, email}`.
- Page: `GET /` shows free slots and a booking form; `POST /` (form-encoded `slot`, `name`, `email`) books and re-renders the page. No JavaScript.
