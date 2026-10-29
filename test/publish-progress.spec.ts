import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Alepha } from "alepha";
import { McpServerProvider } from "alepha/mcp";
import { $repository } from "alepha/orm";
import { AlephaServer } from "alepha/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { AuthController } from "../src/api/controllers/AuthController.ts";
import { DraftsController } from "../src/api/controllers/DraftsController.ts";
import { dealEntity } from "../src/api/entities/Deal.ts";
import { dealabsDraftEntity } from "../src/api/entities/DealabsDraft.ts";
import { ApiModule } from "../src/api/index.ts";
import { AutoPublishService } from "../src/api/services/AutoPublishService.ts";
import { DealabsHistoryService } from "../src/api/services/DealabsHistoryService.ts";
import { DealabsPublisherService } from "../src/api/services/DealabsPublisherService.ts";
import { DealPageCheckService } from "../src/api/services/DealPageCheckService.ts";
import { PriceSeriesService } from "../src/api/services/PriceSeriesService.ts";
import { PublishPauseService } from "../src/api/services/PublishPauseService.ts";
import {
  PublishCancelledError,
  PublishProgressService,
} from "../src/api/services/PublishProgressService.ts";
import {
  currentPublishStep,
  PUBLISH_STEPS,
  type PublishRun,
} from "../src/api/services/publishSteps.ts";

class Fixtures {
  deals = $repository(dealEntity);
  drafts = $repository(dealabsDraftEntity);
}

const statusOf = (run: PublishRun | undefined, id: string) =>
  run?.steps.find((step) => step.id === id)?.status;

describe("publish progress", () => {
  let alepha: Alepha;
  let dir: string;
  let progress: PublishProgressService;
  let fx: Fixtures;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "publish-progress-"));
    process.env.APP_FILES_DIR = dir;
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        AGENT_TOKEN: "p".repeat(64),
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
      },
    })
      .with(AlephaServer)
      .with(ApiModule)
      .with(Fixtures);
    await alepha.start();
    progress = alepha.inject(PublishProgressService);
    fx = alepha.inject(Fixtures);
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("steps move in order; finished runs become « last »", async () => {
    await progress.start({ dealId: "d1", title: "Casque", trigger: "button" });
    let { current } = await progress.get();
    expect(current?.status).toBe("running");
    expect(current?.steps.map((s) => s.id)).toEqual(
      PUBLISH_STEPS.map((s) => s.id),
    );
    expect(current?.steps.every((s) => s.status === "pending")).toBe(true);

    await progress.done("checks");
    await progress.begin("dealabs-duplicate");
    await progress.begin("merchant-check", "https://example.com");
    ({ current } = await progress.get());
    // Beginning a step closes the one still running.
    expect(statusOf(current, "dealabs-duplicate")).toBe("done");
    expect(currentPublishStep(current!)?.id).toBe("merchant-check");

    await progress.skip("cloudflare", "Aucune vérification demandée");
    await progress.finish("https://www.dealabs.com/bons-plans/casque-1");
    const { current: after, last } = await progress.get();
    expect(after).toBeUndefined();
    expect(last?.status).toBe("done");
    expect(last?.dealabsUrl).toContain("casque-1");
    expect(statusOf(last, "merchant-check")).toBe("done");
    expect(statusOf(last, "cloudflare")).toBe("skipped");
    // Never reached on success: skipped, not pending.
    expect(statusOf(last, "submit")).toBe("skipped");
  });

  test("failure marks the running step and keeps later ones pending", async () => {
    await progress.start({ dealId: "d2", title: "Jeu", trigger: "schedule" });
    await progress.done("checks");
    await progress.begin("login");
    await progress.waitForHuman("login", "Connectez-vous");
    let { current } = await progress.get();
    expect(current?.steps.find((s) => s.id === "login")?.needsHuman).toBe(true);

    await progress.fail("Connexion non faite");
    const { last } = await progress.get();
    current = (await progress.get()).current;
    expect(current).toBeUndefined();
    expect(last?.status).toBe("failed");
    expect(last?.error).toBe("Connexion non faite");
    const login = last?.steps.find((s) => s.id === "login");
    expect(login?.status).toBe("failed");
    expect(login?.detail).toBe("Connexion non faite");
    expect(login?.needsHuman).toBeUndefined();
    expect(statusOf(last, "submit")).toBe("pending");
    expect(currentPublishStep(last!)?.id).toBe("login");
  });

  test("reporting without a run never throws", async () => {
    const fresh = Alepha.create().inject(PublishProgressService);
    await expect(fresh.begin("submit")).resolves.toBeUndefined();
    await expect(fresh.fail("x")).resolves.toBeUndefined();
  });

  const makeDeal = async (title: string) => {
    const deal = await fx.deals.create({
      sourceId: "steam",
      externalId: title,
      title,
      url: `https://example.com/${encodeURIComponent(title)}`,
      currentPrice: 19.99,
      status: "active",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    } as any);
    const draft = await fx.drafts.create({
      dealId: deal.id,
      title,
      body: `${title}\n\nUn bon prix.`,
      description: "Un bon prix.",
      generatedAt: new Date().toISOString(),
    } as any);
    return { deal, draft };
  };

  const quietPreflight = () => {
    vi.spyOn(
      alepha.inject(DealabsHistoryService),
      "findLiveDuplicate",
    ).mockResolvedValue(undefined as any);
    vi.spyOn(alepha.inject(DealPageCheckService), "check").mockResolvedValue({
      ok: true,
    } as any);
    vi.spyOn(
      alepha.inject(PriceSeriesService),
      "chartImageUrl",
    ).mockResolvedValue(undefined as any);
  };

  test("a published deal keeps its trail on the draft", async () => {
    const { deal, draft } = await makeDeal("Hades");
    quietPreflight();
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockImplementation(async () => {
      await progress.begin("form-link");
      await progress.begin("submit");
      return { dealabsUrl: "https://www.dealabs.com/bons-plans/hades-9" };
    });

    const posted = await alepha
      .inject(AutoPublishService)
      .publishDeal(deal.id, "button");
    expect(posted.status).toBe("posted");
    const trail = JSON.parse(posted.lastPublishSteps ?? "{}") as PublishRun;
    expect(trail.status).toBe("done");
    expect(trail.dealId).toBe(deal.id);
    expect(trail.trigger).toBe("button");
    expect(statusOf(trail, "dealabs-duplicate")).toBe("done");
    expect(statusOf(trail, "chart")).toBe("skipped");
    expect(statusOf(trail, "submit")).toBe("done");
    expect(draft.id).toBe(posted.id);
  });

  test("a failed publish names its step, on the draft and in progress", async () => {
    const { deal } = await makeDeal("Celeste");
    quietPreflight();
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockImplementation(async () => {
      await progress.begin("form-essentials");
      throw new Error("Champ « Prix » introuvable");
    });

    await expect(
      alepha.inject(AutoPublishService).publishDeal(deal.id, "schedule"),
    ).rejects.toThrow("Prix");
    const saved = await fx.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });
    expect(saved?.lastPublishResult).toBe("failed");
    expect(saved?.publishAttempts).toBe(1);
    const trail = JSON.parse(saved?.lastPublishSteps ?? "{}") as PublishRun;
    expect(trail.status).toBe("failed");
    expect(currentPublishStep(trail)?.id).toBe("form-essentials");
    const { last } = await progress.get();
    expect(last?.dealId).toBe(deal.id);
    expect(last?.trigger).toBe("schedule");
  });

  test("a second publish while one runs is refused, progress untouched", async () => {
    const { deal } = await makeDeal("Dead Cells");
    const { deal: other } = await makeDeal("Hades II");
    quietPreflight();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockImplementation(async () => {
      await progress.begin("form-link");
      await gate;
      return { dealabsUrl: "https://www.dealabs.com/bons-plans/dc-2" };
    });
    const publisher = alepha.inject(AutoPublishService);
    const first = publisher.publishDeal(deal.id);
    await vi.waitFor(async () =>
      expect((await progress.get()).current?.dealId).toBe(deal.id),
    );
    await expect(publisher.publishDeal(other.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await progress.get()).current?.dealId).toBe(deal.id);
    release();
    await expect(first).resolves.toMatchObject({ status: "posted" });
  });

  test("a live duplicate stops before any attempt is counted", async () => {
    const { deal } = await makeDeal("Hollow Knight");
    vi.spyOn(
      alepha.inject(DealabsHistoryService),
      "findLiveDuplicate",
    ).mockResolvedValue({
      url: "https://www.dealabs.com/bons-plans/hk-1",
      price: 7.49,
      temperature: 250,
    } as any);
    const publish = vi.spyOn(alepha.inject(DealabsPublisherService), "publish");

    await expect(
      alepha.inject(AutoPublishService).publishDeal(deal.id),
    ).rejects.toThrow("Déjà en ligne");
    expect(publish).not.toHaveBeenCalled();
    const saved = await fx.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });
    expect(saved?.publishAttempts ?? 0).toBe(0);
    const trail = JSON.parse(saved?.lastPublishSteps ?? "{}") as PublishRun;
    expect(currentPublishStep(trail)?.id).toBe("dealabs-duplicate");
  });

  test("endpoint: 401 anonymous, 200 for the admin and the agent token", async () => {
    const drafts = alepha.inject(DraftsController);
    await expect(drafts.publishProgress.fetch({})).rejects.toMatchObject({
      status: 401,
    });

    const agent = await drafts.publishProgress.fetch({
      headers: { authorization: `Bearer ${"p".repeat(64)}` },
    });
    expect(agent.data.last?.steps.length).toBe(17);

    const login = await alepha.inject(AuthController).login.fetch({
      body: { username: "admin", password: "s3cret-admin-pass" },
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const admin = await drafts.publishProgress.fetch({ headers: { cookie } });
    expect(admin.data.last?.runId).toBe(agent.data.last?.runId);
  });

  test("MCP exposes the progress as a read-only tool", () => {
    const tool = alepha
      .inject(McpServerProvider)
      .getTools()
      .find((t) => t.name === "get_publish_progress");
    expect(tool?.options.annotations?.readOnlyHint).toBe(true);
  });

  test("stop: nothing running, then a run stopped mid-way counts no attempt", async () => {
    expect((await progress.requestStop("vous")).ok).toBe(false);

    const { deal } = await makeDeal("Ori");
    quietPreflight();
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockImplementation(async () => {
      await progress.begin("form-link");
      const answer = await progress.requestStop("vous");
      expect(answer.ok).toBe(true);
      // The next step boundary is where it stops.
      await progress.begin("form-essentials");
      return { dealabsUrl: "https://www.dealabs.com/bons-plans/never" };
    });

    const run = alepha.inject(AutoPublishService).publishDeal(deal.id);
    await expect(run).rejects.toBeInstanceOf(PublishCancelledError);
    await expect(run).rejects.toThrow("rien n'a été posté");
    const saved = await fx.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });
    expect(saved?.status).toBe("draft");
    expect(saved?.publishAttempts ?? 0).toBe(0);
    expect(saved?.lastPublishResult).toBeUndefined();
    const trail = JSON.parse(saved?.lastPublishSteps ?? "{}") as PublishRun;
    expect(trail.status).toBe("cancelled");
    expect(statusOf(trail, "form-link")).toBe("done");
    expect(statusOf(trail, "form-essentials")).toBe("stopped");
    expect(statusOf(trail, "form-description")).toBe("pending");
    expect((await progress.get()).last?.status).toBe("cancelled");
  });

  test("stop: too late once « Envoi » started, the publish goes through", async () => {
    const { deal } = await makeDeal("Tunic");
    quietPreflight();
    let answer: { ok: boolean; message: string } | undefined;
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockImplementation(async () => {
      await progress.begin("submit");
      answer = await progress.requestStop("vous");
      await progress.begin("session-save");
      return { dealabsUrl: "https://www.dealabs.com/bons-plans/tunic-1" };
    });
    const posted = await alepha.inject(AutoPublishService).publishDeal(deal.id);
    expect(answer?.ok).toBe(false);
    expect(answer?.message).toContain("Trop tard");
    expect(posted.status).toBe("posted");
  });

  test("stop endpoint: admin only, the agent token is refused", async () => {
    const drafts = alepha.inject(DraftsController);
    await expect(
      drafts.stopPublish.fetch({
        headers: { authorization: `Bearer ${"p".repeat(64)}` },
      }),
    ).rejects.toMatchObject({ status: 401 });
    const login = await alepha.inject(AuthController).login.fetch({
      body: { username: "admin", password: "s3cret-admin-pass" },
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await drafts.stopPublish.fetch({ headers: { cookie } });
    expect(res.data).toEqual({
      ok: false,
      message: "Aucune publication en cours.",
    });
  });

  test("pause: the button still publishes; only the admin changes it", async () => {
    const pause = alepha.inject(PublishPauseService);
    pause.set({ paused: true }, "vous");
    const { deal } = await makeDeal("Gris");
    quietPreflight();
    vi.spyOn(
      alepha.inject(DealabsPublisherService),
      "publish",
    ).mockResolvedValue({
      dealabsUrl: "https://www.dealabs.com/bons-plans/gris-1",
    });
    const posted = await alepha
      .inject(AutoPublishService)
      .publishDeal(deal.id, "button");
    expect(posted.status).toBe("posted");

    const drafts = alepha.inject(DraftsController);
    const agent = { authorization: `Bearer ${"p".repeat(64)}` };
    expect(
      (await drafts.publishPause.fetch({ headers: agent })).data.paused,
    ).toBe(true);
    expect(
      (await drafts.publishProgress.fetch({ headers: agent })).data.pause
        .paused,
    ).toBe(true);
    await expect(
      drafts.setPublishPause.fetch({ headers: agent, body: { paused: false } }),
    ).rejects.toMatchObject({ status: 401 });

    const login = await alepha.inject(AuthController).login.fetch({
      body: { username: "admin", password: "s3cret-admin-pass" },
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    await expect(
      drafts.setPublishPause.fetch({
        headers: { cookie },
        body: { paused: true, until: "2020-01-01T00:00:00.000Z" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const resumed = await drafts.setPublishPause.fetch({
      headers: { cookie },
      body: { paused: false },
    });
    expect(resumed.data.paused).toBe(false);
    expect(pause.paused).toBe(false);
  });
});
