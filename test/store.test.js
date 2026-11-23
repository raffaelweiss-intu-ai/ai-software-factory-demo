import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStore } from "../src/store.js";

const SLOTS = ["2026-12-01T09:00", "2026-12-01T10:00"];

test("lists the configured slots", () => {
  const s = createStore(SLOTS);
  assert.deepEqual(s.slots(), SLOTS);
});

test("books a slot and returns the booking with an id", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(b.id, 1);
  assert.equal(b.slot, SLOTS[0]);
  assert.equal(s.bookings().length, 1);
});

test("rejects an unknown slot", () => {
  const s = createStore(SLOTS);
  assert.throws(() => s.book({ slot: "2030-01-01T00:00", name: "Ada", email: "ada@example.com" }), /unknown slot/);
});

test("rejects an empty name", () => {
  const s = createStore(SLOTS);
  assert.throws(() => s.book({ slot: SLOTS[0], name: "  ", email: "ada@example.com" }), /name/);
});

test("rejects an email without @", () => {
  const s = createStore(SLOTS);
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Ada", email: "ada.example.com" }), /email/);
});

test("rejects a second booking of the same slot", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" }), /slot already booked/);
});

test("same person booking the same slot twice is also rejected", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" }), /slot already booked/);
});

test("the slot-taken error carries a machine-readable code", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(
    () => s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" }),
    (e) => e.code === "SLOT_TAKEN" && e.message === "slot already booked",
  );
});

test("a rejected booking adds nothing and does not use up an id", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" }));
  assert.equal(s.bookings().length, 1);
  const next = s.book({ slot: SLOTS[1], name: "Bob", email: "bob@example.com" });
  assert.equal(next.id, 2);
  assert.equal(s.bookings().length, 2);
});

test("another slot stays bookable after a rejection", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" }));
  const b = s.book({ slot: SLOTS[1], name: "Bob", email: "bob@example.com" });
  assert.equal(b.slot, SLOTS[1]);
});

test("on a taken slot, validation errors still come first", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(() => s.book({ slot: SLOTS[0], name: "  ", email: "bob@example.com" }), /name is required/);
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Bob", email: "bob.example.com" }), /email is invalid/);
  assert.throws(() => s.book({ slot: "2030-01-01T00:00", name: "Bob", email: "bob@example.com" }), /unknown slot/);
});

test("cancel removes an existing booking and returns true", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(s.cancel(b.id), true);
  assert.equal(s.bookings().some((x) => x.id === b.id), false);
});

test("cancel of an unknown id returns false and changes nothing", () => {
  const s = createStore(SLOTS);
  s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const before = s.bookings();
  assert.equal(s.cancel(999), false);
  assert.deepEqual(s.bookings(), before);
});

test("cancelling the same id twice returns true then false", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(s.cancel(b.id), true);
  assert.equal(s.cancel(b.id), false);
});

test("ids are not reused after a cancel", () => {
  const s = createStore(SLOTS);
  const b1 = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(b1.id, 1);
  s.cancel(b1.id);
  const b2 = s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" });
  assert.equal(b2.id, 2);
});

test("a cancelled slot can be booked again and only the new booking remains", () => {
  const s = createStore(SLOTS);
  const b1 = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  s.cancel(b1.id);
  const { cancelToken, ...b2 } = s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" });
  assert.deepEqual(s.bookings(), [b2]);
});

test("book returns a random cancelToken that differs per booking", () => {
  const s = createStore(SLOTS);
  const b1 = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const b2 = s.book({ slot: SLOTS[1], name: "Bob", email: "bob@example.com" });
  assert.equal(typeof b1.cancelToken, "string");
  assert.match(b1.cancelToken, /^[0-9a-f]{64}$/);
  assert.notEqual(b1.cancelToken, b2.cancelToken);
});

test("cancelWithToken with the right token cancels the booking", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(s.cancelWithToken(b.id, b.cancelToken), "cancelled");
  assert.deepEqual(s.bookings(), []);
});

test("cancelWithToken with a missing or wrong token is forbidden and changes nothing", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const other = s.book({ slot: SLOTS[1], name: "Bob", email: "bob@example.com" });
  const before = s.bookings();
  for (const token of [undefined, null, "", "nope", b.cancelToken.slice(1), b.cancelToken.toUpperCase(), other.cancelToken, 42]) {
    assert.equal(s.cancelWithToken(b.id, token), "forbidden", String(token));
  }
  assert.deepEqual(s.bookings(), before);
});

test("cancelWithToken of an unknown id is not found", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(s.cancelWithToken(999, b.cancelToken), "not found");
  assert.equal(s.cancelWithToken(999, undefined), "not found");
  assert.equal(s.bookings().length, 1);
});

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest();

test("book, cancel, book again on the same slot with double-booking protection active", () => {
  const s = createStore(SLOTS);
  const a = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" }), (e) => e.code === "SLOT_TAKEN");
  assert.equal(s.cancelWithToken(a.id, a.cancelToken), "cancelled");
  const b = s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" });
  assert.equal(b.slot, SLOTS[0]);
  assert.notEqual(b.id, a.id);
  assert.throws(() => s.book({ slot: SLOTS[0], name: "Cy", email: "cy@example.com" }), (e) => e.code === "SLOT_TAKEN");
  assert.deepEqual(s.bookings().map((x) => x.id), [b.id]);
});

test("bookings() never exposes the cancel token or its hash", () => {
  const s = createStore(SLOTS);
  const b1 = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const b2 = s.book({ slot: SLOTS[1], name: "Bob", email: "bob@example.com" });
  const list = s.bookings();
  for (const x of list) assert.deepEqual(Object.keys(x).sort(), ["email", "id", "name", "slot"]);
  const text = JSON.stringify(list);
  for (const { cancelToken } of [b1, b2]) {
    const digest = sha256(cancelToken);
    for (const form of [cancelToken, digest.toString("hex"), digest.toString("base64"), digest.toString("base64url")]) {
      assert.equal(text.includes(form), false, "bookings() leaks the token or its hash");
    }
  }
});

test("the store keeps no reference to the returned booking or its plain token", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const real = b.cancelToken;
  b.cancelToken = "attacker-chosen";
  s.bookings()[0].cancelToken = "attacker-chosen";
  assert.equal(s.cancelWithToken(b.id, "attacker-chosen"), "forbidden");
  assert.equal(s.cancelWithToken(b.id, real), "cancelled");
});

test("the SHA-256 hash of the token is not accepted as the token", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const digest = sha256(b.cancelToken);
  for (const form of [digest.toString("hex"), digest.toString("base64")]) {
    assert.equal(s.cancelWithToken(b.id, form), "forbidden");
  }
  assert.equal(s.bookings().length, 1);
});

// Issue #13: names longer than 100 characters are refused.
test("rejects a 101-character name, stores nothing and keeps the slot free", () => {
  const s = createStore(SLOTS);
  assert.throws(() => s.book({ slot: SLOTS[0], name: "a".repeat(101), email: "ada@example.com" }), {
    message: "name is too long",
  });
  assert.equal(s.bookings().length, 0);
  const b = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  assert.equal(b.slot, SLOTS[0]);
});

test("accepts a 100-character name", () => {
  const s = createStore(SLOTS);
  const name = "a".repeat(100);
  const b = s.book({ slot: SLOTS[0], name, email: "ada@example.com" });
  assert.equal(b.name, name);
});

test("measures the name length after trimming", () => {
  const s = createStore(SLOTS);
  const b = s.book({ slot: SLOTS[0], name: `   ${"a".repeat(100)}   `, email: "ada@example.com" });
  assert.equal(b.name, "a".repeat(100));
  assert.throws(() => s.book({ slot: SLOTS[1], name: `  ${"a".repeat(101)}  `, email: "ada@example.com" }), {
    message: "name is too long",
  });
});

test("an empty or whitespace-only name still says name is required", () => {
  const s = createStore(SLOTS);
  for (const name of ["", "   "]) {
    assert.throws(() => s.book({ slot: SLOTS[0], name, email: "ada@example.com" }), { message: "name is required" });
  }
});
