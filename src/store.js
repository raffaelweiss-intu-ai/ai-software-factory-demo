import { randomBytes, timingSafeEqual } from "node:crypto";

const sameToken = (expected, given) => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

// In-memory store for slots and bookings.

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
    bookings: () => [...bookings],
    book({ slot, name, email }) {
      if (!slots.includes(slot)) throw new Error("unknown slot");
      if (typeof name !== "string" || name.trim() === "") throw new Error("name is required");
      if (typeof email !== "string" || !email.includes("@")) throw new Error("email is invalid");
      if (bookings.some((b) => b.slot === slot)) throw new SlotTakenError();
      const booking = { id: nextId++, slot, name: name.trim(), email, cancelToken: randomBytes(32).toString("hex") };
      bookings.push(booking);
      return booking;
    },
    cancel(id) {
      const i = bookings.findIndex((b) => b.id === id);
      if (i === -1) return false;
      bookings.splice(i, 1);
      return true;
    },
    // Returns "cancelled", "forbidden" (missing or wrong token) or "not found".
    cancelWithToken(id, token) {
      const booking = bookings.find((b) => b.id === id);
      if (!booking) return "not found";
      if (!sameToken(booking.cancelToken, token)) return "forbidden";
      this.cancel(id);
      return "cancelled";
    },
  };
}
