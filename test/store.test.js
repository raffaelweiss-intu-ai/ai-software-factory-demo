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
