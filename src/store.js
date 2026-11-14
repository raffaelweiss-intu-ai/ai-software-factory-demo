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
      const booking = { id: nextId++, slot, name: name.trim(), email };
      bookings.push(booking);
      return booking;
    },
  };
}
