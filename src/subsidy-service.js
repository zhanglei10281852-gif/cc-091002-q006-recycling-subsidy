// 补贴核算服务。
//
// 核算规则（修复后）：
// 1. 每笔原始重量按规定精度解析为定点数，全程不做浮点运算；
// 2. 费率取该笔业务发生当时生效的版本；冲正（更正/撤销）引用原交易当时的费率；
// 3. 单笔不四舍五入，所有行金额按定点精度累加，批次末尾统一舍入一次；
// 4. 月度额度按业务时间顺序扣减，跨上限的金额只截断超出部分；
//    额度没有持久计数器——每次结算都从称重事件与冲正链函数式重算，
//    冲正事件按 id 幂等，因此事件重放不会再次消耗额度；
// 5. 批次内固化每笔使用的费率版本与单价，已公示批次不随费率表更新而变化；
// 6. 同一企业+月份的批次只有一个有效结果，已公示批次原样返回。

import { parseDecimal, formatScaled, roundHalfUp, addScaled } from './decimal.js';

export class SubsidyService {
  constructor(store, rates) {
    this.store = store;
    this.rates = rates;
  }

  add(item) {
    this.store.addWeighing(item);
  }

  /** 登记冲正事件：{ id, type: 'correction'|'reversal', refId, weightKg?, occurredAt } */
  adjust(event) {
    return this.store.applyAdjustment(event);
  }

  settle(company, month, capCents) {
    const key = `${company}:${month}`;
    const frozen = this.store.getBatch(key);
    if (frozen?.status === 'published') return frozen;

    // 由原始称重 + 冲正链派生当前有效记录（冲正后的重量、撤销归零）。
    const rows = this.store
      .effectiveWeighings()
      .filter((w) => w.company === company && w.occurredAt.startsWith(month))
      .sort((a, b) =>
        a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1,
      );

    // 重量精度（规定精度）：保留输入声明的全部小数位；金额精度随之确定。
    const weightScale = rows.reduce((mx, w) => Math.max(mx, parseDecimal(w.weightKg).scale), 0);
    const moneyScale = weightScale; // weightScaled * centsPerKg，scale 与重量一致

    const lines = [];
    let used = { scaled: 0n, scale: moneyScale };
    const cap = { scaled: BigInt(capCents) * 10n ** BigInt(moneyScale), scale: moneyScale };

    for (const w of rows) {
      // 冲正引用原交易当时的费率：始终用原称重业务日期选版本。
      const rate = this.rates.effectiveAt(w.material, w.occurredAt);
      const weight = parseDecimal(w.weightKg);
      // 该笔全额补贴（定点，未舍入）：weightKg × centsPerKg。
      const full = {
        scaled: weight.scaled * BigInt(rate.centsPerKg) * 10n ** BigInt(moneyScale - weight.scale),
        scale: moneyScale,
      };

      // 跨上限只截断超出部分（在定点域内比较，不引入浮点）。
      const remaining = { scaled: cap.scaled - used.scaled, scale: moneyScale };
      const grantedScaled = full.scaled > remaining.scaled ? remaining.scaled : full.scaled;
      used = addScaled(used, { scaled: grantedScaled, scale: moneyScale });

      const truncatedScaled = full.scaled - grantedScaled;
      lines.push({
        weighingId: w.id,
        status: w.status,
        material: w.material,
        occurredAt: w.occurredAt,
        weightKg: w.weightKg,
        ...(w.status === 'active' ? {} : { originalWeightKg: this.store.getWeighing(w.id).weightKg }),
        adjustmentId: w.adjustmentId ?? null,
        adjustmentChain: w.chain,
        // 固化计算依据，旧批次可脱离费率表更新原样复查
        rateVersion: rate.version,
        centsPerKg: rate.centsPerKg,
        amountCentsExact: formatScaled(full.scaled, moneyScale),
        grantedCentsExact: formatScaled(grantedScaled, moneyScale),
        truncatedCentsExact: formatScaled(truncatedScaled, moneyScale),
        capped: truncatedScaled > 0n,
      });
    }

    // 批次末尾统一舍入：唯一一次四舍五入。
    const totalCents = Number(roundHalfUp(used.scaled, moneyScale));
    const batch = {
      company,
      month,
      capCents,
      totalCents,
      totalCentsExact: formatScaled(used.scaled, moneyScale),
      rounding: 'HALF_UP_AT_BATCH_END',
      generatedFrom: {
        weighingIds: rows.map((w) => w.id),
        adjustmentIds: this.store.adjustments
          .filter((e) => rows.some((w) => w.id === e.refId))
          .map((e) => e.id),
      },
      lines,
    };

    return this.store.saveBatch(key, batch);
  }

  publish(company, month, at) {
    return this.store.publishBatch(`${company}:${month}`, at);
  }
}
