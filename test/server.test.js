import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// Cancel tests use their own server and store so the shared one above is untouched.
const CANCEL_SLOTS = ["2026-12-01T09:00", "2026-12-01T10:00"];
const withCancelServer = async (fn) => {
  const store = createStore(CANCEL_SLOTS);
  const srv = createServer(store);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(url, store);
  } finally {
    await new Promise((r) => srv.close(r));
  }
};
const book = (url, body = { slot: CANCEL_SLOTS[0], name: "Ada", email: "ada@example.com" }) =>
  fetch(url + "/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bookOther = (url) => book(url, { slot: CANCEL_SLOTS[1], name: "Bob", email: "bob@example.com" });
const del = (url, path, token) =>
  fetch(url + path, { method: "DELETE", headers: token === undefined ? {} : { "x-cancel-token": token } });

test("POST /api/bookings returns a cancelToken", async () => {
  await withCancelServer(async (url) => {
    const b1 = await (await book(url)).json();
    const b2 = await (await bookOther(url)).json();
    assert.match(b1.cancelToken, /^[0-9a-f]{64}$/);
    assert.notEqual(b1.cancelToken, b2.cancelToken);
  });
});

test("DELETE without X-Cancel-Token answers 403 and cancels nothing", async () => {
  await withCancelServer(async (url, store) => {
    const { id } = await (await book(url)).json();
    const res = await del(url, `/api/bookings/${id}`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "forbidden" });
    assert.equal(store.bookings().length, 1);
  });
});

test("DELETE with a wrong or another booking's token answers 403 and cancels nothing", async () => {
  await withCancelServer(async (url, store) => {
    const { id, cancelToken } = await (await book(url)).json();
    const other = await (await bookOther(url)).json();
    for (const token of ["", "wrong", cancelToken.slice(1), cancelToken + "0", other.cancelToken]) {
      const res = await del(url, `/api/bookings/${id}`, token);
      assert.equal(res.status, 403, token);
      assert.deepEqual(await res.json(), { error: "forbidden" }, token);
    }
    assert.equal(store.bookings().length, 2);
  });
});

test("DELETE unknown id answers 404 with or without a token", async () => {
  await withCancelServer(async (url) => {
    const { cancelToken } = await (await book(url)).json();
    for (const token of [undefined, cancelToken]) {
      const res = await del(url, "/api/bookings/999", token);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not found" });
    }
  });
});

test("the cancelToken is not returned by any other response", async () => {
  await withCancelServer(async (url) => {
    const { id, cancelToken } = await (await book(url)).json();
    const texts = [
      await (await fetch(url + "/api/slots")).text(),
      await (await fetch(url + "/api/bookings")).text(),
      await (await fetch(url + `/api/bookings/${id}`)).text(),
      await (await del(url, `/api/bookings/${id}`)).text(),
      await (await del(url, `/api/bookings/${id}`, "wrong")).text(),
      await (await del(url, `/api/bookings/${id}`, cancelToken)).text(),
      await (await del(url, `/api/bookings/${id}`, cancelToken)).text(),
    ];
    for (const text of texts) assert.equal(text.includes(cancelToken), false);
  });
});

test("DELETE existing booking answers 204 with empty body", async () => {
  await withCancelServer(async (url, store) => {
    const { id, cancelToken } = await (await book(url)).json();
    const res = await del(url, `/api/bookings/${id}`, cancelToken);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(store.bookings().length, 0);
  });
});

test("DELETE unknown id answers 404 not found", async () => {
  await withCancelServer(async (url) => {
    const res = await del(url, "/api/bookings/999");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  });
});

test("second DELETE of the same id answers 404", async () => {
  await withCancelServer(async (url) => {
    const { id, cancelToken } = await (await book(url)).json();
    assert.equal((await del(url, `/api/bookings/${id}`, cancelToken)).status, 204);
    const res = await del(url, `/api/bookings/${id}`, cancelToken);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  });
});

test("DELETE /api/bookings/abc answers 404 and cancels nothing", async () => {
  await withCancelServer(async (url, store) => {
    await book(url);
    const res = await del(url, "/api/bookings/abc");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
    assert.equal(store.bookings().length, 1);
  });
});

test("DELETE /api/bookings and /api/bookings/ answer 404 and cancel nothing", async () => {
  await withCancelServer(async (url, store) => {
    await book(url);
    for (const path of ["/api/bookings", "/api/bookings/", "/api/bookings/1/x", "/api/bookings/-1", "/api/bookings/1.5"]) {
      const res = await del(url, path);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: "not found" }, path);
    }
    assert.equal(store.bookings().length, 1);
  });
});

test("POST, DELETE, POST again for the same slot answers 201", async () => {
  await withCancelServer(async (url) => {
    const { id, cancelToken } = await (await book(url)).json();
    assert.equal((await del(url, `/api/bookings/${id}`, cancelToken)).status, 204);
    assert.equal((await book(url)).status, 201);
  });
});

test("DELETE responses do not leak name or email", async () => {
  await withCancelServer(async (url) => {
    const name = "Zyxwvut Quernhamm";
    const email = "zyx.quern.7731@leakcheck.example";
    const { id, cancelToken } = await (await book(url, { slot: CANCEL_SLOTS[0], name, email })).json();
    for (const [expected, token] of [[403, undefined], [403, "wrong"], [204, cancelToken], [404, cancelToken]]) {
      const res = await del(url, `/api/bookings/${id}`, token);
      assert.equal(res.status, expected);
      const text = await res.text();
      assert.equal(text.includes(name), false);
      assert.equal(text.includes(email), false);
    }
  });
});

test("HTTP: book, 409, cancel, book the same slot again, 409 again", async () => {
  await withCancelServer(async (url) => {
    const first = await book(url);
    assert.equal(first.status, 201);
    const { id, cancelToken } = await first.json();
    const taken = await book(url, { slot: CANCEL_SLOTS[0], name: "Bob", email: "bob@example.com" });
    assert.equal(taken.status, 409);
    assert.deepEqual(await taken.json(), { error: "slot already booked" });
    assert.equal((await del(url, `/api/bookings/${id}`, cancelToken)).status, 204);
    const again = await book(url, { slot: CANCEL_SLOTS[0], name: "Bob", email: "bob@example.com" });
    assert.equal(again.status, 201);
    const rebooked = await again.json();
    assert.equal(rebooked.slot, CANCEL_SLOTS[0]);
    assert.notEqual(rebooked.id, id);
    const takenAgain = await book(url, { slot: CANCEL_SLOTS[0], name: "Cy", email: "cy@example.com" });
    assert.equal(takenAgain.status, 409);
  });
});

test("HTTP: a slot cancelled via the API shows up on the booking page again", async () => {
  await withCancelServer(async (url) => {
    const { id, cancelToken } = await (await book(url)).json();
    assert.equal((await fetch(url + "/")).status, 200);
    assert.equal((await (await fetch(url + "/")).text()).includes(`value="${CANCEL_SLOTS[0]}"`), false);
    assert.equal((await del(url, `/api/bookings/${id}`, cancelToken)).status, 204);
    assert.equal((await (await fetch(url + "/")).text()).includes(`value="${CANCEL_SLOTS[0]}"`), true);
  });
});

test("POST /api/bookings returns the plain token once while the store keeps neither token nor hash visible", async () => {
  await withCancelServer(async (url, store) => {
    const body = await (await book(url)).json();
    assert.match(body.cancelToken, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(body).sort(), ["cancelToken", "email", "id", "name", "slot"]);
    const listed = JSON.stringify(store.bookings());
    const digest = createHash("sha256").update(body.cancelToken, "utf8").digest();
    for (const form of [body.cancelToken, digest.toString("hex"), digest.toString("base64")]) {
      assert.equal(listed.includes(form), false);
    }
  });
});

test("no endpoint other than POST /api/bookings exposes a token or its hash, including the page", async () => {
  await withCancelServer(async (url, store) => {
    const { id, cancelToken } = await (await book(url)).json();
    const digest = createHash("sha256").update(cancelToken, "utf8").digest();
    const forms = [cancelToken, digest.toString("hex"), digest.toString("base64"), digest.toString("base64url")];
    const form = (fields) =>
      fetch(url + "/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });
    const texts = [
      await (await fetch(url + "/")).text(),
      await (await fetch(url + "/api/slots")).text(),
      await (await fetch(url + "/api/bookings")).text(),
      await (await fetch(url + `/api/bookings/${id}`)).text(),
      await (await form({ slot: CANCEL_SLOTS[1], name: "Bob", email: "bob@example.com" })).text(),
      await (await form({ slot: CANCEL_SLOTS[0], name: "Cy", email: "cy@example.com" })).text(),
      await (await form({ slot: "nope", name: "Cy", email: "cy@example.com" })).text(),
      await (await fetch(url + "/")).text(),
      await (await del(url, `/api/bookings/${id}`)).text(),
      await (await del(url, `/api/bookings/${id}`, digest.toString("hex"))).text(),
      await (await del(url, `/api/bookings/${id}`, cancelToken)).text(),
      await (await del(url, `/api/bookings/${id}`, cancelToken)).text(),
    ];
    assert.equal(store.bookings().length, 1, "the page booking of slot 2 is still there");
    for (const text of texts) {
      for (const f of forms) assert.equal(text.includes(f), false);
      // Also covers the token of the booking made through the page, which no test can read.
      assert.doesNotMatch(text, /[0-9a-f]{64}/);
      assert.doesNotMatch(text, /[A-Za-z0-9+/]{43}=/);
    }
  });
});
