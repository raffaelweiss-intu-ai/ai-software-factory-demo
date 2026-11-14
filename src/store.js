// In-memory store for slots and bookings.
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
      const booking = { id: nextId++, slot, name: name.trim(), email };
      bookings.push(booking);
      return booking;
    },
    cancel(id) {
      const i = bookings.findIndex((b) => b.id === id);
      if (i === -1) return false;
      bookings.splice(i, 1);
      return true;
    },
  };
}
