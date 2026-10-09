import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { AttributionError, getSignup, recordOpen, signup } from "./attribution.ts";

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AttributionError("corpo deve ser um objeto JSON", 400);
  }
  return body as Record<string, unknown>;
}

function requiredId(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new AttributionError(`${field} deve ter de 1 a 100 letras, números, hífens ou underscores`, 400);
  }
  return value;
}

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AttributionError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/opens", async (c) => {
    const body = await readBody(c);
    if (body.link !== undefined && (typeof body.link !== "string" || !body.link.trim())) {
      throw new AttributionError("link deve ser uma URL ou ser omitido", 400);
    }
    return c.json(recordOpen(db, requiredId(body, "installation_id"), body.link as string | undefined, now()));
  });

  app.post("/signups", async (c) => {
    const body = await readBody(c);
    return c.json(signup(db, requiredId(body, "installation_id"), requiredId(body, "user_id"), now()));
  });

  app.get("/signups/:userId", (c) => c.json(getSignup(db, c.req.param("userId"))));

  return app;
}
