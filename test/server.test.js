import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { createStore } from "../src/store.js";

let server, base;
before(async () => {
  server = createServer(createStore(["2026-12-01T09:00"]));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/slots returns the slots", async () => {
  const res = await fetch(base + "/api/slots");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), ["2026-12-01T09:00"]);
});

test("POST /api/bookings creates a booking", async () => {
  const res = await post("/api/bookings", { slot: "2026-12-01T09:00", name: "Ada", email: "ada@example.com" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).id, 1);
});

test("POST /api/bookings with invalid data answers 400 and says why", async () => {
  const res = await post("/api/bookings", { slot: "nope", name: "Ada", email: "ada@example.com" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown slot/);
});

test("malformed JSON answers 400, not a crash", async () => {
  const res = await fetch(base + "/api/bookings", { method: "POST", body: "{nope" });
  assert.equal(res.status, 400);
});

test("unknown route answers 404", async () => {
  assert.equal((await fetch(base + "/nope")).status, 404);
});
