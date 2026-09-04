import assert from "node:assert/strict";
import test from "node:test";

import worker from "./index.js";

test("serves the one-click setup landing page without exposing secrets", async () => {
  const response = await worker.fetch(new Request("https://siyaq.example/"), {}, {});
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /SIYAQ/);
  assert.match(html, /href="\/setup"/);
  assert.doesNotMatch(html, /TELEGRAM_BOT_TOKEN/);
});

test("reports the cloud edition health and version", async () => {
  const response = await worker.fetch(new Request("https://siyaq.example/health"), {}, {});
  const data = await response.json();

  assert.deepEqual(data, {
    ok: true,
    service: "SIYAQ | سياق",
    version: "0.4.0",
    mode: "cloudflare-workers-ai",
  });
});

test("rejects Telegram webhook calls without the derived secret", async () => {
  const response = await worker.fetch(
    new Request("https://siyaq.example/telegram", { method: "POST", body: "{}" }),
    {},
    {},
  );

  assert.equal(response.status, 401);
});
