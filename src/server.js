import http from "node:http";
import { createStore } from "./store.js";
import { FormError, MAX_FORM_BYTES, freeSlots, parseForm, renderPage, submitBooking } from "./page.js";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
  });

const html = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};

// Read a form body up to MAX_FORM_BYTES. A larger body is drained and rejected, not buffered.
const readForm = (req) =>
  new Promise((resolve, reject) => {
    const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_FORM_BYTES) chunks.push(c);
    });
    req.on("error", () => reject(new FormError("could not read form")));
    req.on("end", () => {
      if (size > MAX_FORM_BYTES) return reject(new FormError("form too large"));
      if (size > 0 && type !== "application/x-www-form-urlencoded") return reject(new FormError("unsupported form"));
      try {
        resolve(parseForm(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
  });

const FORM_UNREADABLE = { kind: "alert", text: "The form could not be read. Please try again." };

export function createServer(store) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && pathname === "/api/slots") return json(res, 200, store.slots());
    if (req.method === "POST" && pathname === "/api/bookings") {
      try {
        return json(res, 201, store.book(await readJson(req)));
      } catch (e) {
        if (e.code === "SLOT_TAKEN") return json(res, 409, { error: "slot already booked" });
        return json(res, 400, { error: e.message });
      }
    }
    if (req.method === "GET" && pathname === "/") return html(res, 200, renderPage({ slots: freeSlots(store) }));
    if (req.method === "POST" && pathname === "/") {
      let fields;
      try {
        fields = await readForm(req);
      } catch {
        return html(res, 400, renderPage({ slots: freeSlots(store), message: FORM_UNREADABLE }));
      }
      const { status, message, values } = submitBooking(store, fields);
      return html(res, status, renderPage({ slots: freeSlots(store), message, values }));
    }
    const cancelMatch = req.method === "DELETE" && pathname.match(/^\/api\/bookings\/(\d+)$/);
    if (cancelMatch) {
      const result = store.cancelWithToken(Number(cancelMatch[1]), req.headers["x-cancel-token"]);
      if (result === "cancelled") {
        res.writeHead(204);
        return res.end();
      }
      if (result === "forbidden") return json(res, 403, { error: "forbidden" });
    }
    return json(res, 404, { error: "not found" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slots = ["2026-12-01T09:00", "2026-12-01T10:00", "2026-12-01T11:00"];
  createServer(createStore(slots)).listen(process.env.PORT || 3000);
}
