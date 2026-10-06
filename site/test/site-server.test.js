import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// scripts/server.js is what the frontend image runs. It is started here as it is there, as a process
// of its own, with a backend made up for the test behind it.

const siteDir = path.resolve(__dirname, "..");
const indexHtml = path.join(siteDir, "public", "index.html");
const STUB = "<html><head><title>OSRS Guild Map</title></head><body></body></html>";

let backend;
let backendRequests;
let site;
let sitePort;
let madeIndexHtml = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Resolves with the process once it says it listens, or rejects with what it printed when it exits first.
function startSite(port, backendUrl, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/server.js", "--port", String(port), "--backend", backendUrl], {
      cwd: siteDir,
      env: { ...process.env, ...env },
    });
    let output = "";
    const read = (chunk) => {
      output += chunk;
      if (output.includes("Listening on")) resolve(child);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => reject(Object.assign(new Error(`exited with ${code}:\n${output}`), { code, output })));
  });
}

function request(port, urlPath, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.once("error", reject);
    req.end(body);
  });
}

// A backend that answers the first request on a connection and drops the connection, unanswered, when
// another one comes in on it. That is what the real backend's idle timeout looks like when it fires
// just as a request is sent: it closes a connection that nothing came in on for five seconds.
function startBackendThatDropsReusedConnections() {
  const body = '{"members":[]}';
  const server = net.createServer((socket) => {
    let seen = "";
    let answered = false;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (answered) return socket.destroy();
      seen += chunk;
      if (!seen.includes("\r\n\r\n")) return;
      answered = true;
      socket.write(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

beforeAll(async () => {
  // public/index.html is build output. Without a build (CI runs the tests first) a stand-in does.
  if (!fs.existsSync(indexHtml)) {
    fs.mkdirSync(path.dirname(indexHtml), { recursive: true });
    fs.writeFileSync(indexHtml, STUB);
    madeIndexHtml = true;
  }

  backendRequests = [];
  backend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      backendRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith("/api/refused")) {
        res.writeHead(403, { "content-type": "text/plain" }).end("not a member");
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-from-backend": "yes" }).end('{"members":[]}');
      }
    });
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));

  sitePort = await freePort();
  site = await startSite(sitePort, `http://127.0.0.1:${backend.address().port}`, {
    SITE_TITLE: 'Guild <of> "Mock"',
    SITE_NAME: "Mock guild",
  });
}, 30000);

afterAll(async () => {
  if (site) {
    const exited = new Promise((resolve) => site.once("exit", resolve));
    site.kill();
    await exited;
  }
  if (backend) await new Promise((resolve) => backend.close(resolve));
  if (madeIndexHtml) fs.rmSync(indexHtml);
});

describe("site server", () => {
  it("answers the health check", async () => {
    const res = await request(sitePort, "/healthz");

    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });

  it.each(["/", "/index.html", "/guild", "/guild/graphs", "/login/discord?code=abc&state=def"])(
    "serves the page with the site's configuration at %s",
    async (urlPath) => {
      const res = await request(sitePort, urlPath);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain('window.siteConfig = {"title":"Mock guild","pageTitle":"Guild \\u003cof> \\"Mock\\""');
      expect(res.text).toContain("<title>Guild &lt;of&gt; &quot;Mock&quot;</title>");
    },
  );

  it.each(["/icons/items/4151.webp", "/ui/skill.webp", "/map/0_50_50.png"])(
    "answers 404, not the page, for a file that isn't there: %s",
    async (urlPath) => {
      const res = await request(sitePort, urlPath);

      expect(res.status).toBe(404);
      expect(res.text).not.toContain("window.siteConfig");
    },
  );

  it("passes an API request on to the backend, with its path, query and headers", async () => {
    backendRequests.length = 0;

    const res = await request(sitePort, "/api/hub/events?limit=200&after=5", { headers: { cookie: "session=abc" } });

    expect(res.status).toBe(200);
    expect(res.headers["x-from-backend"]).toBe("yes");
    expect(res.text).toBe('{"members":[]}');
    expect(backendRequests).toHaveLength(1);
    expect(backendRequests[0]).toMatchObject({ method: "GET", url: "/api/hub/events?limit=200&after=5" });
    expect(backendRequests[0].headers.cookie).toBe("session=abc");
  });

  it("passes on the body of a POST", async () => {
    backendRequests.length = 0;

    const res = await request(sitePort, "/api/login/discord", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc", state: "def" }),
    });

    expect(res.status).toBe(200);
    expect(backendRequests[0].method).toBe("POST");
    expect(JSON.parse(backendRequests[0].body)).toEqual({ code: "abc", state: "def" });
  });

  it("passes the backend's refusal back as it is", async () => {
    const res = await request(sitePort, "/api/refused");

    expect(res.status).toBe(403);
    expect(res.text).toBe("not a member");
  });

  it("answers every API request when the backend drops a connection it has answered on", async () => {
    const dropping = await startBackendThatDropsReusedConnections();
    const port = await freePort();
    const behind = await startSite(port, `http://127.0.0.1:${dropping.address().port}`);
    try {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await request(port, "/api/members")).status);

      expect(statuses).toEqual([200, 200, 200]);
    } finally {
      const exited = new Promise((resolve) => behind.once("exit", resolve));
      behind.kill();
      await exited;
      await new Promise((resolve) => dropping.close(resolve));
    }
  }, 30000);

  it("stops with an error when its port is taken, instead of saying it listens", async () => {
    const second = startSite(sitePort, "http://127.0.0.1:1");

    await expect(second).rejects.toMatchObject({ code: 1, output: expect.stringContaining("EADDRINUSE") });
    await expect(second).rejects.not.toMatchObject({ output: expect.stringContaining("Listening on") });
  });
});
