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

// Admin list of bookings. Fresh server and store per test; the token is injected unless `options` is undefined.
const ADMIN_PATH = "/api/admin/bookings";
const T = "test-admin-token-1234";
const ADA = { slot: SLOT, name: "Ada Example", email: "ada@example.com" };

const withAdmin = async (options, fn) => {
  const store = createStore([SLOT, "2026-12-02T10:00"]);
  const srv = options === undefined ? createServer(store) : createServer(store, options);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const get = (authorization, method = "GET", path = ADMIN_PATH) =>
    fetch(origin + path, { method, headers: authorization === undefined ? {} : { authorization } });
  try {
    await fn({ store, get });
  } finally {
    await new Promise((r) => srv.close(r));
  }
};

const notFoundBody = async () => {
  let body;
  await withAdmin(undefined, async ({ get }) => {
    body = await (await get(undefined, "GET", "/nope")).json();
  });
  return body;
};

const assertUnauthorized = async (res) => {
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
};

const restoreEnv = (saved) => {
  if (saved === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = saved;
};

test("admin bookings without an Authorization header answers 401", async () => {
  await withAdmin({ adminToken: T }, async ({ get }) => {
    await assertUnauthorized(await get(undefined));
  });
});

test("admin bookings with a wrong, same-length, prefix or longer token answers 401", async () => {
  await withAdmin({ adminToken: T }, async ({ get }) => {
    const sameLength = "x".repeat(T.length);
    for (const token of ["wrong", sameLength, T.slice(0, -1), T + "x"]) {
      await assertUnauthorized(await get(`Bearer ${token}`));
    }
  });
});

test("admin bookings with a Basic scheme, a bare token or an empty Bearer answers 401", async () => {
  await withAdmin({ adminToken: T }, async ({ get }) => {
    for (const header of [`Basic ${T}`, T, "Bearer ", "Bearer", `Bearer  ${T}`]) {
      await assertUnauthorized(await get(header));
    }
  });
});

test("admin bookings with the correct token answers 200 and every booking", async () => {
  await withAdmin({ adminToken: T }, async ({ store, get }) => {
    const booking = store.book(ADA);
    const res = await get(`Bearer ${T}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await res.json(), [{ id: booking.id, slot: booking.slot, name: booking.name, email: booking.email }]);
    assert.equal((await get(`bearer ${T}`)).status, 200, "scheme is case-insensitive");
  });
});

test("admin bookings with the correct token and no bookings answers []", async () => {
  await withAdmin({ adminToken: T }, async ({ get }) => {
    const res = await get(`Bearer ${T}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

test("the admin 401 body leaks no booking data and no token", async () => {
  await withAdmin({ adminToken: T }, async ({ store, get }) => {
    store.book(ADA);
    const cases = [
      [undefined, ""],
      ["Bearer wrong-token-sent", "wrong-token-sent"],
      [`Basic ${T}`, T],
    ];
    for (const [header, sent] of cases) {
      const res = await get(header);
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.ok(!text.includes(ADA.name), "leaks name");
      assert.ok(!text.includes(ADA.email), "leaks email");
      assert.ok(!text.includes(T), "leaks configured token");
      if (sent) assert.ok(!text.includes(sent), "leaks sent token");
    }
  });
});

test("admin bookings with the token unset answers 404 like an unknown route", async () => {
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  try {
    const expected = await notFoundBody();
    await withAdmin(undefined, async ({ store, get }) => {
      store.book(ADA);
      for (const header of [undefined, "Bearer anything", "Bearer "]) {
        const res = await get(header);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), expected);
      }
    });
  } finally {
    restoreEnv(saved);
  }
});

test("admin bookings with an empty token answers 404, never 200 or 401", async () => {
  const expected = await notFoundBody();
  await withAdmin({ adminToken: "" }, async ({ store, get }) => {
    store.book(ADA);
    for (const header of [undefined, "Bearer ", "Bearer x", "Bearer"]) {
      const res = await get(header);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), expected);
    }
  });
});

test("non-GET methods on admin bookings answer 404 even with the correct token", async () => {
  await withAdmin({ adminToken: T }, async ({ get }) => {
    for (const method of ["POST", "DELETE"]) {
      const res = await get(`Bearer ${T}`, method);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not found" });
    }
  });
});

test("admin bookings reads ADMIN_TOKEN on each request", async () => {
  const saved = process.env.ADMIN_TOKEN;
  try {
    await withAdmin(undefined, async ({ get }) => {
      process.env.ADMIN_TOKEN = T;
      assert.equal((await get(`Bearer ${T}`)).status, 200);
      assert.equal((await get(`Bearer ${T}`, "GET", `${ADMIN_PATH}?x=1`)).status, 200, "query string ignored");
      delete process.env.ADMIN_TOKEN;
      assert.equal((await get(`Bearer ${T}`)).status, 404);
      process.env.ADMIN_TOKEN = "";
      assert.equal((await get("Bearer ")).status, 404);
    });
  } finally {
    restoreEnv(saved);
  }
});
