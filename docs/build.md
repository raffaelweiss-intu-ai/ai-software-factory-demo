# How to build and verify

- Run the app: `npm start` (port 3000, in-memory data).
- Checks: `bash factory/checks.sh` (lint and tests). All must pass before a PR is reviewed.
- Tests use `node:test`; no dependencies. Write the failing test first.
- API: `GET /api/slots`, `POST /api/bookings {slot, name, email}`.
- Admin: `GET /api/admin/bookings` lists all bookings with `Authorization: Bearer <ADMIN_TOKEN>`; without `ADMIN_TOKEN` set (or empty) it is disabled and answers 404.
- Page: `GET /` shows free slots and a booking form; `POST /` (form-encoded `slot`, `name`, `email`) books and re-renders the page. No JavaScript.
