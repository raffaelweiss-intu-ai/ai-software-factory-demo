import { test } from "node:test";
import assert from "node:assert/strict";
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
  const b2 = s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" });
  assert.deepEqual(s.bookings(), [b2]);
});

test("book returns a random cancelToken that differs per booking", () => {
  const s = createStore(SLOTS);
  const b1 = s.book({ slot: SLOTS[0], name: "Ada", email: "ada@example.com" });
  const b2 = s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" });
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
  const other = s.book({ slot: SLOTS[0], name: "Bob", email: "bob@example.com" });
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
