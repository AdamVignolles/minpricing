import { $inject, type Infer } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { DealabsHistoryService } from "./DealabsHistoryService.ts";
import { DealPageCheckService } from "./DealPageCheckService.ts";
import {
  isFresh,
  removesDeal,
  verdictFromPageCheck,
  type VerificationResult,
  type VerificationVerdict,
} from "./dealVerification.ts";

type Deal = Infer<typeof dealEntity.schema>;

export interface VerifyOptions {
  /** Ignore a result younger than 10 minutes and look again. */
  force?: boolean;
}

/**
 * The single gate before a deal is posted or kept visible: the Dealabs
 * side (a live thread for the same product at our price or lower) and the
 * merchant side (page up, product there, in stock, price still ours).
 *
 * Only positive evidence changes anything: a gone or out-of-stock product
 * is expired and its draft set aside; a changed price or a live Dealabs
 * thread blocks the publish; a blocked or unreachable page is "unknown" —
 * it holds the publish back and nothing else. Nothing is deleted, and a
 * later `ok` (or a collection run that lists the deal again) brings it back.
 */
export class DealVerificationService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected pageCheck = $inject(DealPageCheckService);
  protected dealabsHistory = $inject(DealabsHistoryService);

  /** One merchant page at a time: the VM has a single vCPU. */
  protected turn: Promise<unknown> = Promise.resolve();

  async verify(
    dealId: string,
    options: VerifyOptions = {},
  ): Promise<VerificationResult> {
    const run = this.turn.then(() => this.verifyNow(dealId, options));
    this.turn = run.catch(() => undefined);
    return run;
  }

  protected async verifyNow(
    dealId: string,
    options: VerifyOptions,
  ): Promise<VerificationResult> {
    const deal = await this.deals.getById(dealId);
    const now = this.dateTime.now().toDate();
    if (!options.force && deal.verifyVerdict && isFresh(deal.verifiedAt, now)) {
      return {
        verdict: deal.verifyVerdict as VerificationVerdict,
        reason: deal.verifyReason || undefined,
      };
    }

    const result = await this.evaluate(deal);
    await this.record(deal, result);
    return result;
  }

  protected async evaluate(deal: Deal): Promise<VerificationResult> {
    // Dealabs first: cheap, no browser. Unknown (Dealabs didn't answer) is
    // not a duplicate; the publisher form has its own warning.
    const duplicate = await this.dealabsHistory
      .findLiveDuplicate(deal)
      .catch(() => undefined);
    if (duplicate) {
      return {
        verdict: "already-on-dealabs",
        reason: `Déjà en ligne sur Dealabs à ${duplicate.price.toFixed(2).replace(".", ",")} € (${Math.round(duplicate.temperature)}°)`,
        duplicate: {
          url: duplicate.url,
          price: duplicate.price,
          temperature: duplicate.temperature,
        },
      };
    }
    if (!this.pageCheck.enabled) return { verdict: "ok" };
    return verdictFromPageCheck(await this.pageCheck.check(deal));
  }

  /** Stamps the verdict on the deal and acts on positive evidence only. */
  protected async record(
    deal: Deal,
    result: VerificationResult,
  ): Promise<void> {
    const wasRemoved =
      deal.verifyVerdict === "gone" || deal.verifyVerdict === "out-of-stock";
    const patch: Partial<Deal> = {
      verifiedAt: this.dateTime.nowISOString(),
      verifyVerdict: result.verdict,
      verifyReason: result.reason ?? "",
    };
    if (removesDeal(result.verdict)) {
      patch.status = "expired";
      if (result.verdict === "out-of-stock")
        patch.availability = "out_of_stock";
      await this.setAside(deal.id);
      this.log.info("Deal removed before posting", {
        dealId: deal.id,
        verdict: result.verdict,
      });
    } else if (result.verdict === "ok" && wasRemoved) {
      // The page is fine again: bring the deal and its draft back.
      patch.status = "active";
      await this.restore(deal.id);
    }
    await this.deals.updateById(deal.id, patch);
  }

  protected async setAside(dealId: string): Promise<void> {
    const draft = await this.drafts.findOne({
      where: { dealId: { eq: dealId } },
    });
    if (draft?.status === "draft") {
      await this.drafts.updateById(draft.id, { status: "discarded" });
    }
  }

  protected async restore(dealId: string): Promise<void> {
    const draft = await this.drafts.findOne({
      where: { dealId: { eq: dealId } },
    });
    if (draft?.status === "discarded" && !draft.publishAttempts) {
      await this.drafts.updateById(draft.id, { status: "draft" });
    }
  }

  /**
   * Re-checks the best visible deals not verified for `maxAgeMs`, a few at
   * a time. @returns the ids it looked at.
   */
  async recheckTop(limit: number, maxAgeMs: number): Promise<string[]> {
    const cutoff = this.dateTime.now().toDate().getTime() - maxAgeMs;
    const top = (
      await this.deals.findMany({
        where: { status: { eq: "active" } },
        orderBy: { column: "hotChance", direction: "desc" },
        limit: limit * 4,
      })
    )
      .filter(
        (deal) =>
          !deal.verifiedAt || new Date(deal.verifiedAt).getTime() < cutoff,
      )
      .slice(0, limit);
    for (const deal of top) {
      await this.verify(deal.id, { force: true }).catch((error) =>
        this.log.warn("Re-check failed", { dealId: deal.id, error }),
      );
    }
    return top.map((deal) => deal.id);
  }
}
