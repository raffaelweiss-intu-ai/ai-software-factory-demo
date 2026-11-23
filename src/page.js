// Server-rendered booking page for customers. No JavaScript, native controls only.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape a value for HTML text and for quoted attribute values.
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const MAX_FORM_BYTES = 10 * 1024;

export class FormError extends Error {}

// Parse an application/x-www-form-urlencoded body strictly: bad percent-encoding throws.
// Only the first value of each field is kept.
export function parseForm(raw) {
  const fields = {};
  if (raw === "") return fields;
  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const [k, v] = eq === -1 ? [pair, ""] : [pair.slice(0, eq), pair.slice(eq + 1)];
    let key, value;
    try {
      key = decodeURIComponent(k.replace(/\+/g, " "));
      value = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      throw new FormError("malformed form body");
    }
    if (!Object.hasOwn(fields, key)) fields[key] = value;
  }
  return fields;
}

export const freeSlots = (store) => {
  const taken = new Set(store.bookings().map((b) => b.slot));
  return store.slots().filter((s) => !taken.has(s));
};

// Text and background colours are WCAG AA (>= 4.5:1); test/page.test.js computes the ratios.
const CSS = `
body { font-family: system-ui, sans-serif; font-size: 1rem; line-height: 1.5; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #ffffff; }
fieldset { border: 1px solid #595959; padding: 0.75rem 1rem; margin: 0 0 1rem; }
legend { font-weight: bold; }
label { display: inline-block; margin: 0.25rem 0; }
.field { margin: 0 0 1rem; }
.field label { display: block; }
input[type="text"], input[type="email"] { font: inherit; padding: 0.4rem; width: 100%; box-sizing: border-box; border: 1px solid #595959; color: #1a1a1a; background: #ffffff; }
button { font: inherit; padding: 0.5rem 1.25rem; border: 0; color: #ffffff; background: #1f4e9c; cursor: pointer; }
:focus-visible, :focus { outline: 3px solid #1f4e9c; outline-offset: 2px; }
.status { padding: 0.75rem 1rem; margin: 0 0 1rem; border-left: 4px solid #0b5d1e; color: #0b5d1e; background: #e6f4ea; }
.alert { padding: 0.75rem 1rem; margin: 0 0 1rem; border-left: 4px solid #8a1c1c; color: #8a1c1c; background: #fdecea; }
`.trim();

// message: { kind: "status" | "alert", text } or undefined.
// values: the name and email to show in the fields; slot: the slot to pre-select.
export function renderPage({ slots, message, values = {} }) {
  const msg = message
    ? `<p class="${message.kind}" role="${message.kind}">${escapeHtml(message.text)}</p>`
    : "";
  const slotGroup = slots.length
    ? `<fieldset>
<legend>Choose a free slot</legend>
${slots
  .map((s, i) => {
    const checked = s === values.slot ? " checked" : "";
    return `<div><input type="radio" name="slot" id="slot-${i}" value="${escapeHtml(s)}"${checked} required> <label for="slot-${i}">${escapeHtml(s)}</label></div>`;
  })
  .join("\n")}
</fieldset>
<div class="field"><label for="name">Your name</label><input type="text" name="name" id="name" value="${escapeHtml(values.name)}" autocomplete="name" required></div>
<div class="field"><label for="email">Your email</label><input type="email" name="email" id="email" value="${escapeHtml(values.email)}" autocomplete="email" required></div>
<button type="submit">Book this slot</button>`
    : `<p>There are no free slots right now. Please check back later.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book an appointment</title>
<style>
${CSS}
</style>
</head>
<body>
<main>
<h1>Book an appointment</h1>
${msg}
<form method="post" action="/">
${slotGroup}
</form>
</main>
</body>
</html>
`;
}

const STORE_ERRORS = {
  "unknown slot": "Please choose one of the free slots.",
  "name is required": "Please enter your name.",
  "name is too long": "Sorry, that name is too long: please use at most 100 characters.",
  "email is invalid": "Please enter a valid email address (it needs an @).",
};

// Turn a form submission into { status, message, values }. Uses store.book() for all rules.
export function submitBooking(store, fields) {
  const values = {
    slot: typeof fields.slot === "string" ? fields.slot : undefined,
    name: typeof fields.name === "string" ? fields.name : "",
    email: typeof fields.email === "string" ? fields.email : "",
  };
  try {
    const booking = store.book(values);
    return { status: 201, message: { kind: "status", text: `Booked: ${booking.slot}. See you then!` }, values: {} };
  } catch (e) {
    if (e.code === "SLOT_TAKEN") {
      return {
        status: 409,
        message: { kind: "alert", text: "Sorry, that slot was just taken. Please choose another slot." },
        values: { name: values.name, email: values.email },
      };
    }
    const text = STORE_ERRORS[e.message] || "The booking could not be saved. Please check your input.";
    return { status: 400, message: { kind: "alert", text }, values };
  }
}
