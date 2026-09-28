import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AVATAR_PRESETS, type S2C } from "@dubroom/shared";
import { issueGuestToken } from "@dubroom/shared/token";
import { GameServer } from "./server.ts";

const KEY = "integration-key-0123456789abcdef";
let server: GameServer;
let base: string;

beforeAll(async () => {
  server = new GameServer({
    signingKeys: [KEY],
    allowedOrigins: ["https://play.example.com"],
    trustCfIp: false,
    catalog: async () => [],
    maxRooms: 10,
    roomIdleMs: 3600_000,
    log: () => {},
  });
  await server.listen(0, "127.0.0.1");
  base = `127.0.0.1:${(server.http.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function client(origin = "https://play.example.com") {
  const ws = new WebSocket(`ws://${base}/ws`, { origin });
  const inbox: S2C[] = [];
  const waiters: [(m: S2C) => boolean, (m: S2C) => void][] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as S2C;
    inbox.push(m);
    for (const w of [...waiters])
      if (w[0](m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w[1](m);
      }
  });
  const next = <T extends S2C["t"]>(
    t: T,
    pred: (m: Extract<S2C, { t: T }>) => boolean = () => true,
  ) =>
    new Promise<Extract<S2C, { t: T }>>((resolve, reject) => {
      const found = inbox.find((m) => m.t === t && pred(m as Extract<S2C, { t: T }>));
      if (found) return resolve(found as Extract<S2C, { t: T }>);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 3000);
      waiters.push([
        (m) => m.t === t && pred(m as Extract<S2C, { t: T }>),
        (m) => {
          clearTimeout(timer);
          resolve(m as Extract<S2C, { t: T }>);
        },
      ]);
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return { ws, inbox, next, opened, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe("game server over WebSocket", () => {
  it("creates a room over HTTP and reports 404 for unknown codes", async () => {
    const res = await fetch(`http://${base}/api/rooms`, { method: "POST" });
    expect(res.status).toBe(201);
    const { code } = (await res.json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    expect((await fetch(`http://${base}/api/rooms/${code.toLowerCase()}`)).status).toBe(200);
    expect((await fetch(`http://${base}/api/rooms/ZZZZZ`)).status).toBe(404);
  });

  it("rejects foreign origins", async () => {
    const c = client("https://evil.example.com");
    await expect(c.opened).rejects.toThrow();
  });

  it("joins with a guest token, syncs clocks, and reconnects to the same seat", async () => {
    const { code } = (await (
      await fetch(`http://${base}/api/rooms`, { method: "POST" })
    ).json()) as { code: string };
    const pid = randomUUID();
    const { token } = issueGuestToken(pid, "secret", KEY);

    const a = client();
    await a.opened;
    a.send({
      t: "join",
      roomCode: code,
      token: "bad-token-xxxxxxxx",
      name: "Аня",
      avatar: AVATAR_PRESETS[0],
    });
    expect((await a.next("error")).code).toBe("bad_token");
    a.send({ t: "join", roomCode: code, token, name: "Аня", avatar: AVATAR_PRESETS[0] });
    const welcome = await a.next("welcome");
    expect(welcome.playerId).toBe(pid);
    expect(welcome.room.players[0]).toMatchObject({ name: "Аня", isHost: true });

    a.send({ t: "ping", clientNow: 123 });
    expect((await a.next("pong")).clientNow).toBe(123);

    a.inbox.length = 0;
    a.send({ t: "nonsense" });
    expect((await a.next("error")).code).toBe("bad_message");

    a.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const b = client();
    await b.opened;
    b.send({ t: "join", roomCode: code, token, name: "Другое имя", avatar: AVATAR_PRESETS[1] });
    const again = await b.next("welcome");
    expect(again.room.players).toHaveLength(1);
    expect(again.room.players[0]).toMatchObject({ name: "Аня", connected: true, isHost: true });
    b.ws.close();
  });

  it("stops creating rooms while draining", async () => {
    server.draining = true;
    expect((await fetch(`http://${base}/api/rooms`, { method: "POST" })).status).toBe(503);
    server.draining = false;
  });
});
