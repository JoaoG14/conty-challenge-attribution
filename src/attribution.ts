import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type Source = { click_id: string; type: "campaign" | "referral"; source_id: string };
type Installation = { id: string; first_opened_at: string; expires_at: string };
type Touch = Source & { id: number; opened_at: string };
type TouchReason = "winner" | "earlier_touch" | "tie_lost" | "outside_window" | "signup_after_window" | "after_signup";
type Decision = {
  user_id: string;
  installation_id: string;
  signed_up_at: string;
  first_opened_at: string;
  expires_at: string;
  rule: "last_touch_v1";
  origin: "organic" | "campaign" | "referral";
  source_id: string | null;
  reason: "attributed" | "no_touch" | "window_expired" | "no_eligible_touch";
  touches: (Touch & { won: boolean; reason: TouchReason })[];
};

export class AttributionError extends Error {
  constructor(message: string, public status: 400 | 404 | 409) {
    super(message);
  }
}

function parseLink(link: string): Source {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new AttributionError("link inválido", 400);
  }
  if (url.origin !== "https://app.conty.test" || url.pathname !== "/open" || url.username || url.password || url.hash) {
    throw new AttributionError("use um link https://app.conty.test/open", 400);
  }
  for (const field of ["click_id", "type", "source_id"]) {
    const values = url.searchParams.getAll(field);
    if (values.length !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(values[0])) {
      throw new AttributionError(`${field} inválido no link`, 400);
    }
  }
  const type = url.searchParams.get("type");
  if (type !== "campaign" && type !== "referral") throw new AttributionError("type deve ser campaign ou referral", 400);
  return { click_id: url.searchParams.get("click_id")!, type, source_id: url.searchParams.get("source_id")! };
}

export function recordOpen(db: DatabaseSync, installationId: string, link: string | undefined, now: Date) {
  return transaction(db, () => {
    const signup = db.prepare("SELECT user_id FROM signups WHERE installation_id = ?").get(installationId);
    if (signup) return { status: "ignored", reason: "after_signup" };

    const source = link === undefined ? null : parseLink(link);
    db.prepare("INSERT OR IGNORE INTO installations (id, first_opened_at, expires_at) VALUES (?, ?, ?)")
      .run(installationId, now.toISOString(), new Date(now.getTime() + WINDOW_MS).toISOString());
    const installation = db.prepare("SELECT * FROM installations WHERE id = ?").get(installationId) as Installation;
    if (!source) return { status: "recorded", installation, touch: null };

    const existing = db.prepare("SELECT id, click_id, type, source_id, opened_at FROM touches WHERE installation_id = ? AND click_id = ?")
      .get(installationId, source.click_id) as Touch | undefined;
    if (existing) {
      if (existing.type !== source.type || existing.source_id !== source.source_id) {
        throw new AttributionError("click_id já usado com outra origem", 409);
      }
      return { status: "duplicate", installation, touch: existing };
    }

    const row = db.prepare("INSERT INTO touches (installation_id, click_id, type, source_id, opened_at) VALUES (?, ?, ?, ?, ?)")
      .run(installationId, source.click_id, source.type, source.source_id, now.toISOString());
    return {
      status: "recorded", installation,
      touch: { id: Number(row.lastInsertRowid), ...source, opened_at: now.toISOString() },
    };
  });
}

export function getSignup(db: DatabaseSync, userId: string): Decision {
  const row = db.prepare("SELECT decision FROM signups WHERE user_id = ?").get(userId) as { decision: string } | undefined;
  if (!row) throw new AttributionError("cadastro não encontrado", 404);
  return JSON.parse(row.decision) as Decision;
}

export function signup(db: DatabaseSync, installationId: string, userId: string, now: Date): Decision {
  return transaction(db, () => {
    const existing = db.prepare("SELECT user_id, installation_id FROM signups WHERE user_id = ? OR installation_id = ?")
      .get(userId, installationId) as { user_id: string; installation_id: string } | undefined;
    if (existing) {
      if (existing.user_id !== userId || existing.installation_id !== installationId) {
        throw new AttributionError("usuário ou instalação já possui cadastro", 409);
      }
      return getSignup(db, userId);
    }

    const installation = db.prepare("SELECT * FROM installations WHERE id = ?").get(installationId) as Installation | undefined;
    if (!installation) throw new AttributionError("registre a primeira abertura antes do cadastro", 409);
    const signedUpAt = now.toISOString();
    if (signedUpAt < installation.first_opened_at) throw new AttributionError("cadastro anterior à primeira abertura", 409);

    const touches = db.prepare("SELECT id, click_id, type, source_id, opened_at FROM touches WHERE installation_id = ? ORDER BY opened_at DESC, id ASC")
      .all(installationId) as Touch[];
    const expired = signedUpAt >= installation.expires_at;
    const eligible = touches.filter((touch) =>
      !expired && touch.opened_at >= installation.first_opened_at &&
      touch.opened_at < installation.expires_at && touch.opened_at <= signedUpAt,
    );
    const winner = eligible[0];
    let reason: Decision["reason"] = "no_touch";
    if (winner) reason = "attributed";
    else if (touches.length > 0) reason = expired ? "window_expired" : "no_eligible_touch";

    const decision: Decision = {
      user_id: userId,
      installation_id: installationId,
      signed_up_at: signedUpAt,
      first_opened_at: installation.first_opened_at,
      expires_at: installation.expires_at,
      rule: "last_touch_v1",
      origin: winner?.type ?? "organic",
      source_id: winner?.source_id ?? null,
      reason,
      touches: touches.map((touch) => {
        let reason: TouchReason;
        if (touch.opened_at > signedUpAt) reason = "after_signup";
        else if (touch.opened_at < installation.first_opened_at || touch.opened_at >= installation.expires_at) reason = "outside_window";
        else if (expired) reason = "signup_after_window";
        else if (touch.id === winner?.id) reason = "winner";
        else reason = touch.opened_at === winner?.opened_at ? "tie_lost" : "earlier_touch";
        return { ...touch, won: reason === "winner", reason };
      }),
    };
    db.prepare("INSERT INTO signups (user_id, installation_id, decision) VALUES (?, ?, ?)")
      .run(userId, installationId, JSON.stringify(decision));
    return decision;
  });
}
