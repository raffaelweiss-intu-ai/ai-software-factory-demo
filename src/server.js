import http from "node:http";
import { createStore } from "./store.js";

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

export function createServer(store) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method === "GET" && pathname === "/api/slots") return json(res, 200, store.slots());
    if (req.method === "POST" && pathname === "/api/bookings") {
      try {
        return json(res, 201, store.book(await readJson(req)));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
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
