import { create } from "zustand";
import { AvatarSpecSchema, randomAvatar, type AvatarSpec } from "@dubroom/shared";
import { load, save } from "./storage.ts";

/**
 * Guest profile (§5.1): playerId + secret are generated on the device; the server signs a
 * 30-day token. Nothing else about the player leaves the browser.
 */
interface Profile {
  playerId: string;
  playerSecret: string;
  name: string;
  avatar: AvatarSpec;
  token: string | null;
  tokenExpiresAt: number;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function initial(): Profile {
  const stored = load<Partial<Profile>>("profile", {});
  const avatar = AvatarSpecSchema.safeParse(stored.avatar);
  return {
    playerId: stored.playerId ?? crypto.randomUUID(),
    playerSecret: stored.playerSecret ?? randomSecret(),
    name: stored.name ?? "",
    avatar: avatar.success ? avatar.data : randomAvatar(),
    token: stored.token ?? null,
    tokenExpiresAt: stored.tokenExpiresAt ?? 0,
  };
}

interface IdentityState extends Profile {
  hasProfile: boolean;
  setProfile: (name: string, avatar: AvatarSpec) => void;
  ensureToken: () => Promise<string>;
}

export const useIdentity = create<IdentityState>((set, get) => {
  const p = initial();
  save("profile", p);
  return {
    ...p,
    hasProfile: p.name.length >= 2,
    setProfile(name, avatar) {
      set({ name, avatar, hasProfile: true });
      save("profile", { ...pick(get()) });
    },
    async ensureToken() {
      const s = get();
      // refresh a week before expiry
      if (s.token && s.tokenExpiresAt - Date.now() > 7 * 24 * 3600_000) return s.token;
      const res = await fetch("/api/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId: s.playerId, playerSecret: s.playerSecret }),
      });
      if (res.status === 403) {
        // secret mismatch (e.g. restored storage) — start a fresh identity
        set({ playerId: crypto.randomUUID(), playerSecret: randomSecret(), token: null });
        save("profile", pick(get()));
        return get().ensureToken();
      }
      if (!res.ok) throw new Error(`guest token: ${res.status}`);
      const body = (await res.json()) as { token: string; expiresAt: number };
      set({ token: body.token, tokenExpiresAt: body.expiresAt });
      save("profile", pick(get()));
      return body.token;
    },
  };
});

function pick(s: Profile): Profile {
  return {
    playerId: s.playerId,
    playerSecret: s.playerSecret,
    name: s.name,
    avatar: s.avatar,
    token: s.token,
    tokenExpiresAt: s.tokenExpiresAt,
  };
}
