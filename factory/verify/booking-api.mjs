// Recipe: the booking API end to end. Own server on a free port, own in-memory store.
import { createServer } from "../../src/server.js";
import { createStore } from "../../src/store.js";

const server = createServer(createStore(["s1", "s2"]));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const say = (m) => console.log(m);
const fail = (m) => { console.error(`FAILED: ${m}`); server.close(); process.exit(1); };
const call = (path, init) => fetch(base + path, init);
const book = (slot) => call("/api/bookings", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ slot, name: "Ada", email: "ada@example.com" }) });

const first = await book("s1");
if (first.status !== 201) fail(`booking a free slot answered ${first.status}, wanted 201`);
const created = await first.json();
if (!created.cancelToken) fail("the booking response has no cancelToken");
say(`booked s1 -> 201, id ${created.id}, token returned once`);

if ((await book("s1")).status !== 409) fail("double booking was not refused with 409");
say("double booking s1 -> 409");

const list = await (await call("/api/slots")).json();
if (list.length !== 2) fail(`/api/slots lists ${list.length} slots, wanted 2`);

if ((await call(`/api/bookings/${created.id}`, { method: "DELETE" })).status !== 403) fail("cancel without a token was not 403");
if ((await call(`/api/bookings/${created.id}`, { method: "DELETE", headers: { "x-cancel-token": "wrong" } })).status !== 403) fail("cancel with a wrong token was not 403");
say("cancel without or with a wrong token -> 403");
if ((await call(`/api/bookings/${created.id}`, { method: "DELETE", headers: { "x-cancel-token": created.cancelToken } })).status !== 204) fail("cancel with the right token was not 204");
if ((await book("s1")).status !== 201) fail("the cancelled slot could not be booked again");
say("cancel with the token -> 204, slot bookable again");
server.close();
say("booking-api OK");
