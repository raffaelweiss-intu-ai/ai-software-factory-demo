import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Cancel tokens are kept only as SHA-256 digests. Both sides are 32-byte digests, so
// timingSafeEqual always compares equal lengths and never throws.
const digest = (token) => createHash("sha256").update(token, "utf8").digest();
const sameToken = (expectedDigest, given) => typeof given === "string" && timingSafeEqual(expectedDigest, digest(given));

// The public view of a stored booking: never the token digest.
const publicView = ({ id, slot, name, email }) => ({ id, slot, name, email });

// In-memory store for slots and bookings.

// Longest accepted name, counted on the trimmed (stored) value in JS string length.
const MAX_NAME_LENGTH = 100;

// Thrown when a slot already has a booking. Callers check `code`, not the message.
export class SlotTakenError extends Error {
  constructor() {
    super("slot already booked");
    this.name = "SlotTakenError";
    this.code = "SLOT_TAKEN";
  }
}

export function createStore(slots) {
  const bookings = [];
  let nextId = 1;
  return {
    slots: () => [...slots],
    bookings: () => bookings.map(publicView),
    book({ slot, name, email }) {
      if (!slots.includes(slot)) throw new Error("unknown slot");
      if (typeof name !== "string" || name.trim() === "") throw new Error("name is required");
      if (name.trim().length > MAX_NAME_LENGTH) throw new Error("name is too long");
      if (typeof email !== "string" || !email.includes("@")) throw new Error("email is invalid");
      if (bookings.some((b) => b.slot === slot)) throw new SlotTakenError();
      const cancelToken = randomBytes(32).toString("hex");
      const record = { id: nextId++, slot, name: name.trim(), email, tokenDigest: digest(cancelToken) };
      bookings.push(record);
      // The plain token leaves the store only here, once; the store keeps just its digest.
      return { ...publicView(record), cancelToken };
    },
    cancel(id) {
      const i = bookings.findIndex((b) => b.id === id);
      if (i === -1) return false;
      bookings.splice(i, 1);
      return true;
    },
    // Returns "cancelled", "forbidden" (missing or wrong token) or "not found".
    cancelWithToken(id, token) {
      const i = bookings.findIndex((b) => b.id === id);
      if (i === -1) return "not found";
      if (!sameToken(bookings[i].tokenDigest, token)) return "forbidden";
      bookings.splice(i, 1);
      return "cancelled";
    },
  };
}
