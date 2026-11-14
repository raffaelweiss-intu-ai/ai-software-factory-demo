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

// Fresh server and store per test: the shared server above already books 2026-12-01T09:00.
const withServer = async (slots, fn) => {
  const srv = createServer(createStore(slots));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/api/bookings`;
  const send = (body) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await fn(send);
  } finally {
    await new Promise((r) => srv.close(r));
  }
};

const SLOT = "2026-12-02T09:00";

test("double booking answers 201 then 409 with a clear error", async () => {
  await withServer([SLOT], async (send) => {
    const first = await send({ slot: SLOT, name: "Ada", email: "ada@example.com" });
    assert.equal(first.status, 201);
    await first.json();
    const second = await send({ slot: SLOT, name: "Bob", email: "bob@example.com" });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "slot already booked" });
  });
});

test("the 409 body does not leak the first booking", async () => {
  await withServer([SLOT], async (send) => {
    const first = await (await send({ slot: SLOT, name: "Ada Lovelace", email: "ada@example.com" })).json();
    const res = await send({ slot: SLOT, name: "Bob", email: "bob@example.com" });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.ok(!text.includes("Ada Lovelace"), "leaks name");
    assert.ok(!text.includes("ada@example.com"), "leaks email");
    assert.ok(!text.includes('"id"') && !text.includes(String(first.id)), "leaks id");
  });
});

test("invalid input on a taken slot still answers 400", async () => {
  await withServer([SLOT], async (send) => {
    assert.equal((await send({ slot: SLOT, name: "Ada", email: "ada@example.com" })).status, 201);
    const noName = await send({ slot: SLOT, email: "bob@example.com" });
    assert.equal(noName.status, 400);
    assert.match((await noName.json()).error, /name is required/);
    const unknown = await send({ slot: "nope", name: "Bob", email: "bob@example.com" });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /unknown slot/);
  });
});
