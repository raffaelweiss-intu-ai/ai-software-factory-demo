// Recipe: the customer booking page end to end, without JavaScript, as a browser form post would do it.
import { createServer } from "../../src/server.js";
import { createStore } from "../../src/store.js";

const server = createServer(createStore(["2026-12-01T09:00", "2026-12-01T10:00"]));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const say = (m) => console.log(m);
const fail = (m) => { console.error(`FAILED: ${m}`); server.close(); process.exit(1); };
const post = (fields) => fetch(base + "/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString() });

const page = await (await fetch(base + "/")).text();
if (!page.includes("2026-12-01T09:00") || !page.includes("<form")) fail("the page does not show the free slots and a form");
say("GET / shows both free slots and a form");

const ok = await post({ slot: "2026-12-01T09:00", name: "Ada", email: "ada@example.com" });
const after = await ok.text();
if (ok.status !== 200 && ok.status !== 201) fail(`a valid booking answered ${ok.status}`);
if (after.includes('value="2026-12-01T09:00"')) fail("the booked slot is still offered");
say(`POST / books the slot (${ok.status}) and it disappears from the form`);

const again = await post({ slot: "2026-12-01T09:00", name: "Bob", email: "bob@example.com" });
if (again.status < 400) fail(`booking a taken slot answered ${again.status}, wanted an error`);
say(`booking the taken slot again -> ${again.status}`);

const evil = await post({ slot: "2026-12-01T10:00", name: "<script>alert(1)</script>", email: "x" });
if ((await evil.text()).includes("<script>alert(1)</script>")) fail("user input is not escaped");
say("user input is escaped");
server.close();
say("booking-page OK");
