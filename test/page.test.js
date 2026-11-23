import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { createStore } from "../src/store.js";
import { renderPage, submitBooking } from "../src/page.js";

const A = "2026-12-01T09:00";
const B = "2026-12-01T10:00";

// Fresh server and store per test.
const withServer = async (slots, fn) => {
  const store = createStore(slots);
  const srv = createServer(store);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = () => fetch(base + "/");
  const submit = (fields) =>
    fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  try {
    await fn({ store, base, get, submit });
  } finally {
    await new Promise((r) => srv.close(r));
  }
};

const count = (html, re) => (html.match(re) || []).length;
const radios = (html) => [...html.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const inputValue = (html, name) => {
  const tag = (html.match(new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`)) || [])[0];
  return tag && attr(tag, "value");
};

// AC 1
test("GET / answers an HTML document with lang, title and one h1", async () => {
  await withServer([A, B], async ({ get }) => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.equal(count(html, /<h1\b/g), 1);
  });
});

// AC 2
test("GET / lists only free slots, each radio with a matching label", async () => {
  await withServer([A, B], async ({ store, get }) => {
    store.book({ slot: A, name: "Ada", email: "ada@example.com" });
    const html = await (await get()).text();
    const rs = radios(html);
    assert.equal(rs.length, 1);
    assert.equal(attr(rs[0], "name"), "slot");
    assert.equal(attr(rs[0], "value"), B);
    const id = attr(rs[0], "id");
    assert.ok(id, "radio has an id");
    assert.match(html, new RegExp(`<label for="${id}">${B}</label>`));
    assert.ok(!html.includes(A), "booked slot is not shown");
  });
});

// AC 3
test("GET / has a post form with fieldset, legend, labelled name and email, submit", async () => {
  await withServer([A, B], async ({ get }) => {
    const html = await (await get()).text();
    assert.match(html, /<form method="post" action="\/">/);
    assert.match(html, /<fieldset>\s*<legend>[^<]+<\/legend>/);
    const fieldset = html.slice(html.indexOf("<fieldset>"), html.indexOf("</fieldset>"));
    assert.equal(radios(fieldset).length, 2, "radios sit inside the fieldset");
    const name = html.match(/<input\b[^>]*name="name"[^>]*>/)[0];
    const email = html.match(/<input\b[^>]*name="email"[^>]*>/)[0];
    assert.equal(attr(name, "type"), "text");
    assert.equal(attr(email, "type"), "email");
    assert.match(html, new RegExp(`<label for="${attr(name, "id")}">`));
    assert.match(html, new RegExp(`<label for="${attr(email, "id")}">`));
    assert.match(html, /<button type="submit">[^<]+<\/button>/);
    // Tab order follows DOM order: slots, name, email, submit.
    const order = [html.indexOf('type="radio"'), html.indexOf('name="name"'), html.indexOf('name="email"'), html.indexOf('type="submit"')];
    assert.deepEqual([...order].sort((x, y) => x - y), order);
    assert.ok(!/tabindex/.test(html), "no tabindex overrides");
  });
});

// AC 4
test("GET / with all slots booked shows a no-free-slots notice and no radios", async () => {
  await withServer([A], async ({ store, get }) => {
    store.book({ slot: A, name: "Ada", email: "ada@example.com" });
    const html = await (await get()).text();
    assert.ok(!html.includes('type="radio"'));
    assert.match(html, /no free slots/i);
  });
});

// AC 5
test("POST / books the slot and confirms it in a status message", async () => {
  await withServer([A, B], async ({ store, submit, get }) => {
    const res = await submit({ slot: A, name: "  Ada  ", email: "ada@example.com" });
    assert.ok([200, 201].includes(res.status), `status ${res.status}`);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await res.text();
    const msg = html.match(/<[a-z]+ [^>]*role="status"[^>]*>([\s\S]*?)<\//);
    assert.ok(msg, "has a role=status container");
    assert.ok(msg[1].includes(A), "message names the slot");
    assert.ok(!radios(html).some((r) => attr(r, "value") === A), "booked slot not listed in response");
    assert.ok(!radios(await (await get()).text()).some((r) => attr(r, "value") === A), "booked slot not listed on GET");
    assert.deepEqual(store.bookings().map(({ slot, name, email }) => ({ slot, name, email })), [
      { slot: A, name: "Ada", email: "ada@example.com" },
    ]);
  });
});

// AC 6
for (const [label, fields, why] of [
  ["unknown slot", { slot: "nope", name: "Ada", email: "ada@example.com" }, /slot/i],
  ["no slot", { name: "Ada", email: "ada@example.com" }, /slot/i],
  ["empty name", { slot: A, name: "", email: "ada@example.com" }, /name/i],
  ["email without @", { slot: A, name: "Ada", email: "ada.example.com" }, /email/i],
]) {
  test(`POST / with ${label} answers 400 with an alert and keeps the input`, async () => {
    await withServer([A, B], async ({ store, submit }) => {
      const res = await submit(fields);
      assert.equal(res.status, 400);
      const html = await res.text();
      const msg = html.match(/<[a-z]+ [^>]*role="alert"[^>]*>([\s\S]*?)<\//);
      assert.ok(msg, "has a role=alert container");
      assert.match(msg[1], why);
      assert.equal(inputValue(html, "name"), fields.name);
      assert.equal(inputValue(html, "email"), fields.email);
      assert.equal(store.bookings().length, 0);
    });
  });
}

// AC 7
test("POST / for a taken slot answers 409 without leaking the first booking", async () => {
  await withServer([A, B], async ({ store, submit }) => {
    const first = await submit({ slot: A, name: "Ada Lovelace", email: "ada@example.com" });
    assert.ok([200, 201].includes(first.status));
    await first.text();
    const res = await submit({ slot: A, name: "Bob", email: "bob@example.com" });
    assert.equal(res.status, 409);
    const html = await res.text();
    const msg = html.match(/<[a-z]+ [^>]*role="alert"[^>]*>([\s\S]*?)<\//);
    assert.ok(msg, "has a role=alert container");
    assert.match(msg[1], /taken/i);
    assert.match(msg[1], /another/i);
    assert.ok(!html.includes("Ada Lovelace"), "leaks name");
    assert.ok(!html.includes("ada@example.com"), "leaks email");
    const id = String(store.bookings()[0].id);
    // The <head> is static markup (viewport meta has "initial-scale=1"); check everything after it.
    const markup = html.slice(html.indexOf("</head>")).replace(/2026-12-01T\d\d:\d\d/g, "");
    assert.ok(!new RegExp(`\\b${id}\\b`).test(markup.replace(/<h1\b/g, "")), "leaks id");
    assert.ok(!radios(html).some((r) => attr(r, "value") === A), "taken slot not listed");
    assert.ok(radios(html).some((r) => attr(r, "value") === B), "other slot still listed");
    assert.equal(store.bookings().length, 1);
  });
});

// AC 8
test("POST / escapes name and email in text and attributes", async () => {
  await withServer([A], async ({ submit }) => {
    const name = `<script>alert(1)</script>"'&`;
    const email = `x"onfocus='alert(1)'`;
    const res = await submit({ slot: A, name, email });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes(`"onfocus=`), "email does not break out of the attribute");
    assert.ok(!html.includes(`'alert(1)'`));
    // Parsing the attribute back gives the escaped original.
    assert.equal(inputValue(html, "name"), "&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;");
    assert.equal(inputValue(html, "email"), "x&quot;onfocus=&#39;alert(1)&#39;");
  });
});

test("POST / escapes a hostile slot value in the response", async () => {
  await withServer([A], async ({ submit }) => {
    const res = await submit({ slot: `"><img src=x>`, name: "Ada", email: "ada@example.com" });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(!html.includes("<img"));
    assert.ok(!html.includes(`"><img`));
  });
});

// AC 9
test("message container comes before the form; plain GET / has none", async () => {
  await withServer([A, B], async ({ submit, get }) => {
    const ok = await (await submit({ slot: A, name: "Ada", email: "ada@example.com" })).text();
    assert.ok(ok.indexOf('role="status"') > -1 && ok.indexOf('role="status"') < ok.indexOf("<form"));
    const bad = await (await submit({ slot: "nope", name: "Ada", email: "ada@example.com" })).text();
    assert.ok(bad.indexOf('role="alert"') > -1 && bad.indexOf('role="alert"') < bad.indexOf("<form"));
    const plain = await (await get()).text();
    assert.ok(!plain.includes('role="status"'));
    assert.ok(!plain.includes('role="alert"'));
  });
});

// AC 10
const luminance = (hex) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("page has no script, a focus style and AA contrast for every colour pair", async () => {
  await withServer([A], async ({ get }) => {
    const html = await (await get()).text();
    assert.ok(!/<script\b/i.test(html), "no script element");
    const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1];
    assert.ok(css, "has inline CSS");
    assert.match(css, /:focus(-visible)?\b[^{]*\{[^}]*outline:\s*[^;]*\d/);
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const pairs = rules
      .map(([, sel, body]) => ({
        sel: sel.trim(),
        fg: (body.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i) || [])[1],
        bg: (body.match(/background(?:-color)?:\s*(#[0-9a-f]{6})/i) || [])[1],
      }))
      .filter((p) => p.fg && p.bg);
    assert.ok(pairs.length >= 3, "body, success and error colour pairs are declared");
    for (const p of pairs) {
      assert.ok(contrast(p.fg, p.bg) >= 4.5, `${p.sel}: ${p.fg} on ${p.bg} is ${contrast(p.fg, p.bg).toFixed(2)}`);
    }
  });
});

// AC 11
test("malformed or missing form body answers 400 and the server keeps working", async () => {
  await withServer([A], async ({ base, get }) => {
    const bad = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "slot=%E0%A4%A&name=%ZZ",
    });
    assert.equal(bad.status, 400);
    await bad.text();
    const empty = await fetch(base + "/", { method: "POST" });
    assert.equal(empty.status, 400);
    await empty.text();
    const big = await fetch(base + "/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=" + "a".repeat(20_000),
    }).catch(() => null);
    if (big) {
      assert.equal(big.status, 400);
      await big.text().catch(() => {});
    }
    assert.equal((await get()).status, 200);
  });
});

// AC 12
test("other methods on / still answer the JSON 404", async () => {
  await withServer([A], async ({ base }) => {
    for (const method of ["PUT", "DELETE"]) {
      const res = await fetch(base + "/", { method });
      assert.equal(res.status, 404);
      assert.match(res.headers.get("content-type"), /application\/json/);
      assert.deepEqual(await res.json(), { error: "not found" });
    }
  });
});

test("JSON API is unchanged next to the page", async () => {
  await withServer([A, B], async ({ base, submit }) => {
    await (await submit({ slot: A, name: "Ada", email: "ada@example.com" })).text();
    const slots = await fetch(base + "/api/slots");
    assert.deepEqual(await slots.json(), [A, B]);
    const res = await fetch(base + "/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: A, name: "Bob", email: "bob@example.com" }),
    });
    assert.equal(res.status, 409);
  });
});

// Job 008: cancel from the booking page.

const CANCEL_FAILED = "Could not cancel: check the booking number and cancel token.";
const FORM_UNREADABLE_TEXT = "The form could not be read. Please try again.";
const alertText = (html) => ((html.match(/<[a-z]+ [^>]*role="alert"[^>]*>([\s\S]*?)<\//) || [])[1]);
const statusText = (html) => ((html.match(/<[a-z]+ [^>]*role="status"[^>]*>([\s\S]*?)<\//) || [])[1]);
const TOKEN_RE = /[0-9a-f]{64}/g;
const cancelForm = (html) => {
  const start = html.indexOf('<form method="post" action="/cancel">');
  return start === -1 ? "" : html.slice(start, html.indexOf("</form>", start) + 7);
};
const postCancel = (base, fields, headers = { "content-type": "application/x-www-form-urlencoded" }) =>
  fetch(base + "/cancel", { method: "POST", headers, body: typeof fields === "string" ? fields : new URLSearchParams(fields).toString() });
const bookViaPage = async (submit, fields = { slot: A, name: "Ada", email: "ada@example.com" }) => {
  const res = await submit(fields);
  const html = await res.text();
  const tokens = html.match(TOKEN_RE) || [];
  const id = (html.match(/Booking number:\s*<strong>(\d+)<\/strong>/) || [])[1];
  return { res, html, tokens, id };
};

test("submitBooking success carries the booking id and cancelToken", () => {
  const store = createStore([A]);
  const result = submitBooking(store, { slot: A, name: "Ada", email: "ada@example.com" });
  assert.equal(result.status, 201);
  assert.equal(result.booking.id, store.bookings()[0].id);
  assert.match(result.booking.cancelToken, /^[0-9a-f]{64}$/);
  assert.equal(store.cancelWithToken(result.booking.id, result.booking.cancelToken), "cancelled");
});

test("submitBooking failure carries no booking", () => {
  const store = createStore([A]);
  assert.equal(submitBooking(store, { slot: "nope", name: "Ada", email: "ada@example.com" }).booking, undefined);
});

test("renderPage shows id and token once with a save-it note, escaped", () => {
  const html = renderPage({ slots: [], booking: { id: `<b>7</b>`, cancelToken: `"><img src=x>` } });
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<b>7</b>"));
  assert.ok(html.includes("&lt;b&gt;7&lt;/b&gt;"));
  assert.ok(html.includes("&quot;&gt;&lt;img src=x&gt;"));
  assert.match(html, /save/i);
  assert.match(html, /cannot be shown again/i);
  assert.ok(!/save/i.test(renderPage({ slots: [] }).replace(/<style>[\s\S]*?<\/style>/, "")), "no note without a booking");
});

test("renderPage always has a labelled cancel form posting to /cancel", () => {
  for (const slots of [[A], []]) {
    const html = renderPage({ slots });
    const form = cancelForm(html);
    assert.ok(form, "has the cancel form");
    assert.match(html, /Cancel a booking/);
    for (const name of ["id", "token"]) {
      const tag = (form.match(new RegExp(`<input\\b[^>]*name="${name}"[^>]*>`)) || [])[0];
      assert.ok(tag, `input ${name}`);
      assert.equal(attr(tag, "type"), "text");
      assert.equal(attr(tag, "autocomplete"), "off");
      assert.match(tag, /\brequired\b/);
      assert.ok(attr(tag, "id"));
      assert.match(form, new RegExp(`<label for="${attr(tag, "id")}">[^<]+</label>`));
    }
    assert.match(form, /<button type="submit">[^<]+<\/button>/);
    assert.ok(!/<script\b/i.test(html));
  }
});

test("POST / answers 201, no-store, and shows id and a token that cancels the booking", async () => {
  await withServer([A, B], async ({ store, submit }) => {
    const { res, tokens, id } = await bookViaPage(submit);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(tokens.length >= 1, true, "token shown");
    assert.equal(new Set(tokens).size, 1, "one token");
    assert.equal(id, String(store.bookings()[0].id));
    assert.equal(store.cancelWithToken(Number(id), tokens[0]), "cancelled");
  });
});

test("the token is absent from later pages and failed responses", async () => {
  await withServer([A, B], async ({ base, get, submit }) => {
    const { tokens, id } = await bookViaPage(submit);
    const token = tokens[0];
    const later = [
      await (await get()).text(),
      await (await submit({ slot: A, name: "Bob", email: "bob@example.com" })).text(),
      await (await submit({ slot: "nope", name: "Bob", email: "bob@example.com" })).text(),
      await (await postCancel(base, { id, token: "wrong" })).text(),
      await (await postCancel(base, { id, token })).text(),
      await (await get()).text(),
    ];
    for (const html of later) assert.equal(html.includes(token), false);
  });
});

test("POST /cancel with the shown values cancels end to end and frees the slot", async () => {
  await withServer([A, B], async ({ store, base, submit, get }) => {
    const { tokens, id } = await bookViaPage(submit);
    const res = await postCancel(base, { id, token: tokens[0] });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(statusText(html), "Booking cancelled.");
    assert.ok(radios(html).some((r) => attr(r, "value") === A), "slot free again in response");
    assert.ok(radios(await (await get()).text()).some((r) => attr(r, "value") === A), "slot free again on GET");
    assert.equal(store.bookings().length, 0);
  });
});

test("POST /cancel failures answer 403 with one identical generic alert", async () => {
  await withServer([A, B], async ({ store, base, submit }) => {
    const { tokens, id } = await bookViaPage(submit);
    const token = tokens[0];
    const cases = [
      { id, token: "wrong" },
      { id, token: token.slice(1) },
      { id, token: "" },
      { id },
      { id: "999", token },
      { id: "abc", token },
      { id: "", token },
      { token },
      {},
    ];
    for (const fields of cases) {
      const res = await postCancel(base, fields);
      assert.equal(res.status, 403, JSON.stringify(fields));
      const html = await res.text();
      assert.equal(alertText(html), CANCEL_FAILED, JSON.stringify(fields));
      assert.equal(html.includes(token), false);
    }
    const empty = await fetch(base + "/cancel", { method: "POST" });
    assert.equal(empty.status, 403);
    assert.equal(alertText(await empty.text()), CANCEL_FAILED);
    assert.equal(store.bookings().length, 1, "booking unchanged");
  });
});

test("POST /cancel with an unreadable body answers 400 with the form alert", async () => {
  await withServer([A], async ({ store, base, submit }) => {
    const { tokens, id } = await bookViaPage(submit);
    const bodies = [
      postCancel(base, `id=${id}&token=${tokens[0]}`, { "content-type": "application/json" }),
      postCancel(base, `id=${id}&token=${tokens[0]}`, { "content-type": "text/plain" }),
      postCancel(base, "id=%ZZ&token=%E0%A4%A"),
      postCancel(base, `id=${id}&token=${tokens[0]}&pad=` + "a".repeat(20_000)).catch(() => null),
    ];
    for (const p of bodies) {
      const res = await p;
      if (!res) continue;
      assert.equal(res.status, 400);
      assert.equal(alertText(await res.text()), FORM_UNREADABLE_TEXT);
    }
    assert.equal(store.bookings().length, 1);
  });
});

test("markup in the name does not break the success page", async () => {
  await withServer([A], async ({ submit }) => {
    const { res, html } = await bookViaPage(submit, { slot: A, name: `<script>x</script>`, email: "a@b.c" });
    assert.equal(res.status, 201);
    assert.ok(!/<script\b/i.test(html));
    assert.ok(cancelForm(html));
  });
});
