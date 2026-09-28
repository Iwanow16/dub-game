import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { emptyManifest } from "@dubroom/clip-format";
import { Db } from "@dubroom/db";
import { issueUploadTicket, verifyDubReceipt } from "@dubroom/shared/token";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

process.env.NODE_ENV = "test";
const KEY = "test-signing-key-0123456789abcdef";
const STUDIO = "studio-key-0123456789";

let dir: string;
let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dubroom-api-"));
  const config = loadConfig({ DATA_DIR: dir, TOKEN_SIGNING_KEY: KEY, STUDIO_KEY: STUDIO });
  db = new Db(config.dbPath);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);
const auth = { authorization: `Bearer ${STUDIO}` };

const manifest = () =>
  emptyManifest({
    id: "c_apitest0001",
    slug: "api-test",
    title: { ru: "Тест" },
    durationMs: 12_000,
    credit: "DubRoom",
    license: "Own work",
    lines: [{ id: "l1", role: "r1", startMs: 1000, endMs: 3000, text: { ru: "Привет" } }],
  });

describe("guest identity", () => {
  it("issues a token and re-issues only with the same secret", async () => {
    const playerId = randomUUID();
    const playerSecret = "s".repeat(43);
    const r1 = await app.inject({
      method: "POST",
      url: "/api/guest",
      payload: { playerId, playerSecret },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().token).toBeTruthy();
    const r2 = await app.inject({
      method: "POST",
      url: "/api/guest",
      payload: { playerId, playerSecret },
    });
    expect(r2.statusCode).toBe(200);
    const r3 = await app.inject({
      method: "POST",
      url: "/api/guest",
      payload: { playerId, playerSecret: "x".repeat(43) },
    });
    expect(r3.statusCode).toBe(403);
  });
});

describe("dubs", () => {
  it("accepts an upload with a valid ticket and serves it back", async () => {
    const pid = randomUUID();
    const { ticket } = issueUploadTicket("ABCDE", 1, pid, KEY);
    const up = await app.inject({
      method: "POST",
      url: "/api/dubs",
      headers: { "x-upload-ticket": ticket, "content-type": "audio/webm" },
      payload: webm(),
    });
    expect(up.statusCode).toBe(200);
    const { dubId, receipt } = up.json() as { dubId: string; receipt: string };
    expect(dubId).not.toContain(pid);
    expect(verifyDubReceipt(receipt, [KEY])).toMatchObject({
      dub: dubId,
      room: "ABCDE",
      round: 1,
      sub: pid,
    });
    const get = await app.inject({ method: "GET", url: `/media/dubs/${dubId}` });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("audio/webm");
    expect(get.rawPayload.length).toBe(204);
  });

  it("lets long clips upload longer takes, up to the ticket's limit", async () => {
    const pid = randomUUID();
    const long = Buffer.concat([webm(), Buffer.alloc(5 * 1024 * 1024)]);
    const small = issueUploadTicket("ABCDE", 1, pid, KEY).ticket;
    const big = issueUploadTicket("ABCDE", 1, pid, KEY, { maxBytes: 8 * 1024 * 1024 }).ticket;
    const up = (ticket: string) =>
      app.inject({
        method: "POST",
        url: "/api/dubs",
        headers: { "x-upload-ticket": ticket, "content-type": "audio/webm" },
        payload: long,
      });
    expect((await up(small)).statusCode).toBe(413);
    expect((await up(big)).statusCode).toBe(200);
  });

  it("rejects missing tickets, wrong formats and oversized files", async () => {
    const { ticket } = issueUploadTicket("ABCDE", 1, randomUUID(), KEY);
    const noTicket = await app.inject({
      method: "POST",
      url: "/api/dubs",
      headers: { "content-type": "audio/webm" },
      payload: webm(),
    });
    expect(noTicket.statusCode).toBe(401);
    const html = await app.inject({
      method: "POST",
      url: "/api/dubs",
      headers: { "x-upload-ticket": ticket, "content-type": "audio/webm" },
      payload: Buffer.from("<html><script>alert(1)</script></html>"),
    });
    expect(html.statusCode).toBe(415);
    const big = await app.inject({
      method: "POST",
      url: "/api/dubs",
      headers: { "x-upload-ticket": ticket, "content-type": "audio/webm" },
      payload: Buffer.concat([webm(), Buffer.alloc(3 * 1024 * 1024)]),
    });
    expect(big.statusCode).toBe(413);
    expect(
      (await app.inject({ method: "GET", url: "/media/dubs/../../etc/passwd" })).statusCode,
    ).toBe(404);
  });
});

describe("studio", () => {
  it("requires the studio key", async () => {
    expect((await app.inject({ method: "GET", url: "/api/studio/clips" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/studio/clips",
          headers: { authorization: "Bearer nope" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/studio/clips", headers: auth })).statusCode,
    ).toBe(200);
  });

  it("runs draft → chunked upload → submit → review → publish → catalog", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/studio/drafts",
      headers: auth,
      payload: { manifest: manifest() },
    });
    expect(create.statusCode).toBe(200);
    const { draftId } = create.json() as { draftId: string };

    // submit without video fails
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/studio/drafts/${draftId}/submit`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);

    const data = Buffer.alloc(1000, 7);
    const put = (offset: number, chunk: Buffer) =>
      app.inject({
        method: "PUT",
        url: `/api/studio/drafts/${draftId}/files/video?offset=${offset}&total=1000`,
        headers: { ...auth, "content-type": "application/octet-stream" },
        payload: chunk,
      });
    expect((await put(0, data.subarray(0, 600))).json()).toEqual({ received: 600 });
    expect((await put(100, data.subarray(600))).statusCode).toBe(409); // wrong offset
    const status = await app.inject({
      method: "GET",
      url: `/api/studio/drafts/${draftId}/files/video`,
      headers: auth,
    });
    expect(status.json()).toMatchObject({ received: 600, size: 1000 });
    expect((await put(600, data.subarray(600))).json()).toEqual({ received: 1000 });
    expect(db.getDraft(draftId)!.proxyStatus).toBe("queued");

    // signed media link: streams without the Authorization header, only for this draft
    const link = (
      await app.inject({
        method: "GET",
        url: `/api/studio/drafts/${draftId}/media-link`,
        headers: auth,
      })
    ).json() as { proxy: string };
    expect((await app.inject({ method: "GET", url: link.proxy })).statusCode).toBe(404); // no proxy file yet, but authorized
    expect(
      (await app.inject({ method: "GET", url: link.proxy.replace(/t=.*/, "t=forged.sig") }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: `/api/studio/drafts/${draftId}/source/video` }))
        .statusCode,
    ).toBe(401);

    const ranged = await app.inject({
      method: "GET",
      url: `/api/studio/drafts/${draftId}/source/video`,
      headers: { ...auth, range: "bytes=10-19" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.length).toBe(10);

    const submit = await app.inject({
      method: "POST",
      url: `/api/studio/drafts/${draftId}/submit`,
      headers: auth,
    });
    expect(submit.statusCode).toBe(200);

    // media worker side
    const claimed = db.claimQueuedDraft();
    expect(claimed?.id).toBe(draftId);
    const built = {
      ...claimed!.manifest,
      media: {
        video: [{ height: 360, codec: "avc1", url: "video/360p.aaaa.mp4", bytes: 1 }],
        bed: [{ codec: "opus", url: "audio/bed.bbbb.opus", bytes: 1 }],
        poster: "poster.cccc.webp",
        preview: null,
      },
    };
    db.finishProcessing(draftId, { manifest: built, warnings: [] });

    const clips = (
      await app.inject({ method: "GET", url: "/api/studio/clips", headers: auth })
    ).json() as { clips: { status: string }[] };
    expect(clips.clips[0]!.status).toBe("review");
    expect((await app.inject({ method: "GET", url: "/api/catalog" })).json().clips).toHaveLength(0);

    const pub = await app.inject({
      method: "POST",
      url: `/api/studio/clips/c_apitest0001/versions/1/publish`,
      headers: auth,
    });
    expect(pub.statusCode).toBe(200);
    const cat = (await app.inject({ method: "GET", url: "/api/catalog" })).json();
    expect(cat.clips).toHaveLength(1);
    expect(cat.clips[0]).toMatchObject({
      id: "c_apitest0001",
      rolesCount: 1,
      manifestUrl: "/media/clips/c_apitest0001/v1/manifest.json",
      posterUrl: "/media/clips/c_apitest0001/v1/poster.cccc.webp",
    });

    // a second version supersedes the first on publish
    const d2 = db.createDraft(randomUUID(), manifest(), "t");
    expect(d2.version).toBe(2);

    await app.inject({
      method: "POST",
      url: `/api/studio/clips/c_apitest0001/archive`,
      headers: auth,
    });
    expect((await app.inject({ method: "GET", url: "/api/catalog" })).json().clips).toHaveLength(0);
    await app.inject({
      method: "POST",
      url: `/api/studio/clips/c_apitest0001/unarchive`,
      headers: auth,
    });
    expect((await app.inject({ method: "GET", url: "/api/catalog" })).json().clips).toHaveLength(1);
  });

  it("rejects duplicate slugs for different clips", async () => {
    await app.inject({
      method: "POST",
      url: "/api/studio/drafts",
      headers: auth,
      payload: { manifest: manifest() },
    });
    const other = { ...manifest(), id: "c_other000001" };
    const r = await app.inject({
      method: "POST",
      url: "/api/studio/drafts",
      headers: auth,
      payload: { manifest: other },
    });
    expect(r.statusCode).toBe(409);
  });
});
