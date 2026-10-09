import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { getSignup } from "../src/attribution.ts";

type Decision = ReturnType<typeof getSignup>;

const campaign = "https://app.conty.test/open?type=campaign&source_id=cmp_01&click_id=click_01";
const referral = "https://app.conty.test/open?type=referral&source_id=crt_01&click_id=click_02";

describe("origem do cadastro", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof createApp>;
  let currentTime: string;

  beforeEach(() => {
    currentTime = "2026-10-09T12:00:00.000Z";
    db = openDatabase();
    app = createApp(db, () => new Date(currentTime));
  });

  afterEach(() => db.close());

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function open(link?: string, installationId = "install_01") {
    return post("/opens", { installation_id: installationId, link });
  }

  async function signup(): Promise<Decision> {
    const response = await post("/signups", { installation_id: "install_01", user_id: "user_01" });
    expect(response.status).toBe(200);
    return response.json() as Promise<Decision>;
  }

  async function read(): Promise<Decision> {
    const response = await app.request("/signups/user_01");
    expect(response.status).toBe(200);
    return response.json() as Promise<Decision>;
  }

  it("grava a primeira abertura sem depender de referrer", async () => {
    const response = await open(campaign);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "recorded",
      installation: {
        id: "install_01", first_opened_at: currentTime, expires_at: "2026-10-16T12:00:00.000Z",
      },
      touch: { click_id: "click_01", type: "campaign", source_id: "cmp_01", opened_at: currentTime },
    });
    const decision = await signup();
    expect(decision).toMatchObject({
      origin: "campaign", source_id: "cmp_01", reason: "attributed", rule: "last_touch_v1",
      touches: [{ click_id: "click_01", won: true, reason: "winner" }],
    });
    expect(await read()).toEqual(decision);
  });

  it("marca cadastro sem toque como orgânico e grava o motivo", async () => {
    await open();
    const decision = await signup();
    expect(decision).toMatchObject({ origin: "organic", source_id: null, reason: "no_touch", touches: [] });
    expect(await read()).toEqual(decision);
  });

  it("considera link recebido depois de uma primeira abertura sem origem", async () => {
    await open();
    currentTime = "2026-10-10T12:00:00.000Z";
    await open(referral);
    expect(await signup()).toMatchObject({ origin: "referral", first_opened_at: "2026-10-09T12:00:00.000Z" });
  });

  it("escolhe o último de dois links e explica os dois resultados", async () => {
    await open(campaign);
    currentTime = "2026-10-09T13:00:00.000Z";
    await open(referral);
    currentTime = "2026-10-09T14:00:00.000Z";
    const decision = await signup();
    expect(decision).toMatchObject({ origin: "referral", source_id: "crt_01", reason: "attributed" });
    expect(decision.touches).toEqual([
      { id: 2, click_id: "click_02", type: "referral", source_id: "crt_01", opened_at: "2026-10-09T13:00:00.000Z", won: true, reason: "winner" },
      { id: 1, click_id: "click_01", type: "campaign", source_id: "cmp_01", opened_at: "2026-10-09T12:00:00.000Z", won: false, reason: "earlier_touch" },
    ]);
  });

  it.each([[campaign, referral, "campaign"], [referral, campaign, "referral"]])(
    "desempata pela ordem de gravação, sem prioridade por tipo: %s", async (first, second, origin) => {
      await open(first);
      await open(second);
      const decision = await signup();
      expect(decision.origin).toBe(origin);
      expect(decision.touches.map((touch) => [touch.won, touch.reason])).toEqual([
        [true, "winner"], [false, "tie_lost"],
      ]);
    },
  );

  it("repetir um clique não cria toque nem o transforma no mais recente", async () => {
    const first = await (await open(campaign)).json();
    currentTime = "2026-10-09T13:00:00.000Z";
    await open(referral);
    currentTime = "2026-10-09T14:00:00.000Z";
    expect(await (await open(campaign)).json()).toEqual({ ...first, status: "duplicate" });
    const decision = await signup();
    expect(decision.origin).toBe("referral");
    expect(decision.touches).toHaveLength(2);
  });

  it("recusa reutilizar click_id com outra origem", async () => {
    await open(campaign);
    expect((await open(referral.replace("click_02", "click_01"))).status).toBe(409);
    expect((await signup()).touches).toHaveLength(1);
  });

  it("permite dois cliques diferentes na mesma campanha", async () => {
    await open(campaign);
    currentTime = "2026-10-09T13:00:00.000Z";
    await open(campaign.replace("click_01", "click_03"));
    const decision = await signup();
    expect(decision.touches).toHaveLength(2);
    expect(decision.touches[0]).toMatchObject({ click_id: "click_03", won: true });
  });

  it.each([
    ["2026-10-16T11:59:59.999Z", "campaign", "attributed"],
    ["2026-10-16T12:00:00.000Z", "organic", "window_expired"],
    ["2026-10-16T12:00:00.001Z", "organic", "window_expired"],
  ])("aplica a janela de sete dias no cadastro: %s", async (time, origin, reason) => {
    await open(campaign);
    currentTime = time;
    const decision = await signup();
    expect(decision).toMatchObject({ origin, reason });
    expect(decision.touches[0].reason).toBe(origin === "campaign" ? "winner" : "signup_after_window");
  });

  it("novas aberturas e links não reiniciam a janela, mesmo sem origem inicial", async () => {
    await open();
    currentTime = "2026-10-15T12:00:00.000Z";
    await open(campaign);
    await open();
    currentTime = "2026-10-16T12:00:00.000Z";
    await open(referral);
    const decision = await signup();
    expect(decision).toMatchObject({
      origin: "organic", reason: "window_expired",
      first_opened_at: "2026-10-09T12:00:00.000Z", expires_at: "2026-10-16T12:00:00.000Z",
    });
    expect(decision.touches.map((touch) => touch.reason)).toEqual(["outside_window", "signup_after_window"]);
    expect(decision.touches.every((touch) => !touch.won)).toBe(true);
  });

  it.each([undefined, campaign])(
    "ignora links após o cadastro e preserva a decisão: %s", async (link) => {
      await open(link);
      const decision = await signup();
      // Mesmo milissegundo, mas o cadastro já foi gravado.
      expect(await (await open(referral)).json()).toEqual({ status: "ignored", reason: "after_signup" });
      currentTime = "2026-10-20T12:00:00.000Z";
      expect(await (await open(campaign)).json()).toEqual({ status: "ignored", reason: "after_signup" });
      expect(await signup()).toEqual(decision);
      expect(await read()).toEqual(decision);
    },
  );

  it("mantém cliques e cadastros separados por instalação", async () => {
    await open(campaign);
    await open(referral, "install_02");
    expect((await signup()).origin).toBe("campaign");
    const response = await post("/signups", { installation_id: "install_02", user_id: "user_02" });
    expect(await response.json()).toMatchObject({ origin: "referral", touches: [{ click_id: "click_02" }] });
  });

  it("impede outro usuário na mesma instalação ou o mesmo usuário em outra instalação", async () => {
    await open(campaign);
    const decision = await signup();
    await open(referral, "install_02");
    expect((await post("/signups", { installation_id: "install_01", user_id: "user_02" })).status).toBe(409);
    expect((await post("/signups", { installation_id: "install_02", user_id: "user_01" })).status).toBe(409);
    expect(await read()).toEqual(decision);
  });

  it("exige a primeira abertura antes do cadastro", async () => {
    expect((await post("/signups", { installation_id: "missing", user_id: "user_01" })).status).toBe(409);
    expect((await app.request("/signups/user_01")).status).toBe(404);
  });

  it("usa o relógio do servidor, sem aceitar datas do cliente", async () => {
    await post("/opens", { installation_id: "install_01", link: campaign, first_opened_at: "2099-01-01", opened_at: "2099-01-01" });
    const response = await post("/signups", { installation_id: "install_01", user_id: "user_01", signed_up_at: "2099-01-01" });
    expect(await response.json()).toMatchObject({ first_opened_at: currentTime, signed_up_at: currentTime });
  });

  it.each([
    "não é uma URL",
    campaign.replace("&click_id=click_01", ""),
    `${campaign}&click_id=outro`,
  ])("recusa link inválido sem gravar uma origem: %s", async (link) => {
    expect((await open(link)).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS count FROM touches").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM installations").get()).toEqual({ count: 0 });
  });

  it("exige installation_id no corpo da abertura", async () => {
    expect((await post("/opens", {})).status).toBe(400);
  });

  it("recusa JSON malformado", async () => {
    const response = await app.request("/opens", { method: "POST", body: "{" });
    expect(response.status).toBe(400);
  });

  it("preserva janela, deduplicação e auditoria após reabrir o banco", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conty-attribution-"));
    const path = join(directory, "test.sqlite");
    db.close();
    db = openDatabase(path);
    app = createApp(db, () => new Date(currentTime));
    try {
      await open(campaign);
      db.close();
      db = openDatabase(path);
      app = createApp(db, () => new Date(currentTime));
      currentTime = "2026-10-10T12:00:00.000Z";
      expect(await (await open(campaign)).json()).toMatchObject({ status: "duplicate" });
      const decision = await signup();
      expect(decision.first_opened_at).toBe("2026-10-09T12:00:00.000Z");
      db.close();
      db = openDatabase(path);
      app = createApp(db, () => new Date(currentTime));
      expect(await read()).toEqual(decision);
      expect(await signup()).toEqual(decision);
    } finally {
      db.close();
      db = openDatabase();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
