import assert from "node:assert/strict";
import test from "node:test";

import worker, { runTranslationModel, SiyaqState } from "./index.js";

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    return this.values.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
}

function stateRequest(path, body) {
  return new Request(`https://state.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("serves the one-click setup landing page without exposing secrets", async () => {
  const response = await worker.fetch(new Request("https://siyaq.example/"), {}, {});
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /SIYAQ/);
  assert.match(html, /href="\/setup"/);
  assert.doesNotMatch(html, /TELEGRAM_BOT_TOKEN/);
});

test("reports the cloud edition health, version, and admin configuration", async () => {
  const response = await worker.fetch(
    new Request("https://siyaq.example/health"),
    { ADMIN_USER_IDS: "123456" },
    {},
  );
  const data = await response.json();

  assert.deepEqual(data, {
    ok: true,
    service: "SIYAQ | سياق",
    version: "0.5.1",
    mode: "cloudflare-workers-ai",
    adminConfigured: true,
  });
});

test("uses a structured fallback model when the primary translation is empty", async () => {
  const calls = [];
  const env = {
    AI: {
      async run(modelId, request) {
        calls.push({ modelId, request });
        if (modelId.includes("qwen")) return { response: "" };
        return { response: { segments: [{ id: 1, translation: "مرحبًا بالعالم" }] } };
      },
    },
  };

  const mapping = await runTranslationModel(
    env,
    "Translate faithfully.",
    { segments_to_translate: [{ id: 1, source: "Hello world" }] },
    [1],
  );

  assert.equal(mapping.get(1), "مرحبًا بالعالم");
  assert.equal(calls.filter((call) => call.modelId.includes("qwen")).length, 2);
  const fallback = calls.find((call) => call.modelId.includes("llama-3.3-70b"));
  assert.equal(fallback.request.response_format.type, "json_schema");
});

test("clears a stuck cancellation before accepting another job", async () => {
  const storage = new MemoryStorage();
  const state = new SiyaqState({ storage }, {});
  await storage.put("latest:123", "job-1");
  await storage.put("job:job-1", { id: "job-1", userId: "123", status: "cancel_requested" });
  await storage.put("quota:reservation:job-1", { userId: "123", day: "2026-09-04", seconds: 14 });
  await storage.put("quota:user:2026-09-04:123", 14);
  await storage.put("quota:global:2026-09-04", 14);

  const response = await state.fetch(stateRequest("/jobs/active", { userId: "123" }));
  assert.deepEqual(await response.json(), { job: null, recovered: true });
  assert.equal((await storage.get("job:job-1")).status, "cancelled");
  assert.equal(await storage.get("quota:user:2026-09-04:123"), 0);
  assert.equal(await storage.get("quota:global:2026-09-04"), 0);
  assert.equal(await storage.get("quota:reservation:job-1"), undefined);
});

test("cancel releases quota and no longer blocks a new upload", async () => {
  const storage = new MemoryStorage();
  const state = new SiyaqState({ storage }, {});
  await storage.put("latest:123", "job-2");
  await storage.put("job:job-2", { id: "job-2", userId: "123", status: "processing" });
  await storage.put("quota:reservation:job-2", { userId: "123", day: "2026-09-04", seconds: 30 });
  await storage.put("quota:user:2026-09-04:123", 30);
  await storage.put("quota:global:2026-09-04", 30);

  const cancel = await state.fetch(stateRequest("/jobs/cancel-latest", { userId: "123" }));
  assert.deepEqual(await cancel.json(), { cancelled: true, released: true });
  assert.equal((await storage.get("job:job-2")).status, "cancel_requested");
  assert.equal(await storage.get("quota:user:2026-09-04:123"), 0);

  const active = await state.fetch(stateRequest("/jobs/active", { userId: "123" }));
  assert.deepEqual(await active.json(), { job: null, recovered: true });
  assert.equal((await storage.get("job:job-2")).status, "cancelled");
});

test("tracks users and lets an admin inspect, ban, unban, and cancel", async () => {
  const storage = new MemoryStorage();
  const state = new SiyaqState({ storage }, {});

  await state.fetch(stateRequest("/users/touch", {
    userId: "123456",
    chatId: "123456",
    username: "owner",
    firstName: "Owner",
  }));
  await state.fetch(stateRequest("/users/touch", {
    userId: "654321",
    chatId: "654321",
    username: "viewer",
    firstName: "Viewer",
  }));
  await storage.put("latest:654321", "job-user");
  await storage.put("job:job-user", { id: "job-user", userId: "654321", status: "processing" });

  const ban = await state.fetch(stateRequest("/admin/ban", { targetUserId: "654321" }));
  assert.deepEqual(await ban.json(), { changed: true, cancelled: true, released: false });
  assert.equal((await storage.get("job:job-user")).status, "cancel_requested");

  const profile = await state.fetch(stateRequest("/admin/user", { targetUserId: "654321" }));
  assert.equal((await profile.json()).banned, true);

  const stats = await state.fetch(stateRequest("/admin/stats", {}));
  const dashboard = await stats.json();
  assert.equal(dashboard.users, 2);
  assert.equal(dashboard.banned, 1);
  assert.equal(dashboard.jobs.active, 1);

  const unban = await state.fetch(stateRequest("/admin/unban", { targetUserId: "654321" }));
  assert.deepEqual(await unban.json(), { changed: true });
});

test("claims exactly one durable administrator", async () => {
  const storage = new MemoryStorage();
  const state = new SiyaqState({ storage }, {});

  const first = await state.fetch(stateRequest("/admin/claim", { userId: "385255528" }));
  assert.deepEqual(await first.json(), { ok: true, already: false });

  const check = await state.fetch(stateRequest("/admin/is-admin", { userId: "385255528" }));
  assert.deepEqual(await check.json(), { admin: true });

  const repeated = await state.fetch(stateRequest("/admin/claim", { userId: "385255528" }));
  assert.deepEqual(await repeated.json(), { ok: true, already: true });

  const rejected = await state.fetch(stateRequest("/admin/claim", { userId: "999999999" }));
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { ok: false, reason: "already_claimed" });
});

test("bypasses application quota reservations for an admin job", async () => {
  const storage = new MemoryStorage();
  const state = new SiyaqState({ storage }, {});
  const response = await state.fetch(stateRequest("/quota/claim", {
    userId: "123456",
    jobId: "admin-job",
    seconds: 900,
    bypass: true,
    perUserLimit: 60,
    globalLimit: 60,
  }));

  assert.deepEqual(await response.json(), { ok: true, bypassed: true });
  assert.equal(await storage.get("quota:reservation:admin-job"), undefined);
});

test("rejects Telegram webhook calls without the derived secret", async () => {
  const response = await worker.fetch(
    new Request("https://siyaq.example/telegram", { method: "POST", body: "{}" }),
    {},
    {},
  );

  assert.equal(response.status, 401);
});
