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
