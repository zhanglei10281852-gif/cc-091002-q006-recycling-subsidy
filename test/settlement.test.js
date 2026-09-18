import test from 'node:test';
import assert from 'node:assert/strict';
import { RateBook } from '../src/rate-book.js';
import { SubsidyStore } from '../src/subsidy-store.js';
import { SubsidyService } from '../src/subsidy-service.js';
import { parseDecimal, roundHalfUp, addScaled } from '../src/decimal.js';

// 两个精度可能不同的定点数判等。
function eqScaled(a, b) {
  if (a.scale === b.scale) return a.scaled === b.scaled;
  return a.scale > b.scale
    ? a.scaled === b.scaled * 10n ** BigInt(a.scale - b.scale)
    : a.scaled * 10n ** BigInt(b.scale - a.scale) === b.scaled;
}

// 构造一套两期费率：2026 年内 1~8 月 25 分/kg，9 月起 30 分/kg。
function twoPeriodRates() {
  return new RateBook([
    { version: '2026.1', material: 'pet-a', effectiveFrom: '2026-01-01', centsPerKg: 25 },
    { version: '2026.9', material: 'pet-a', effectiveFrom: '2026-09-01', centsPerKg: 30 },
  ]);
}

function weigh(id, company, weightKg, day, material = 'pet-a') {
  return { id, company, material, weightKg, occurredAt: `${day}T09:00:00+08:00` };
}

// 从批次明细（称重重量 × 固化的费率版本单价 + 冲正链状态）独立重算批次总额。
function recomputeTotal(batch, capCents) {
  // 先用明细自身声明的精度校验每行金额，再统一到批次最大精度累加。
  let used = { scaled: 0n, scale: 0 };
  const capScale = Math.max(0, ...batch.lines.map((l) => parseDecimal(l.weightKg).scale));
  for (const line of batch.lines) {
    const w = parseDecimal(line.status === 'voided' ? 0 : line.weightKg);
    const exact = { scaled: w.scaled * BigInt(line.centsPerKg), scale: w.scale };
    // 明细金额必须等于 重量 × 该笔固化费率
    assert.ok(
      eqScaled(exact, parseDecimal(line.amountCentsExact)),
      `${line.weighingId} 明细金额对不上`,
    );
    const exactAtMax = {
      scaled: exact.scaled * 10n ** BigInt(capScale - exact.scale),
      scale: capScale,
    };
    const capLeft = {
      scaled: BigInt(capCents) * 10n ** BigInt(capScale) - used.scaled,
      scale: capScale,
    };
    const granted = exactAtMax.scaled > capLeft.scaled ? capLeft.scaled : exactAtMax.scaled;
    used = addScaled(used, { scaled: granted, scale: capScale });
  }
  return Number(roundHalfUp(used.scaled, used.scale));
}

test('批次末尾统一舍入：0.1kg×3 不再逐笔四舍五入', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 0.1, '2026-08-01'));
  service.add(weigh('TX-2', 'REC-1', 0.1, '2026-08-02'));
  service.add(weigh('TX-3', 'REC-1', 0.1, '2026-08-03'));
  const batch = service.settle('REC-1', '2026-08', 1_000_000);

  // 8 月费率 25：每笔精确 2.5 分，逐笔 round 会得 3×3=9；正确做法是合计 7.5 后一次四舍五入 = 8。
  assert.equal(batch.totalCents, 8);
  assert.equal(batch.totalCentsExact, '7.5');
  assert.deepEqual(batch.lines.map((l) => l.amountCentsExact), ['2.5', '2.5', '2.5']);
  assert.equal(recomputeTotal(batch, 1_000_000), batch.totalCents);
});

test('费率按业务发生日期选版本，冲正引用原交易当时费率', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-OLD', 'REC-1', 100, '2026-08-15'));
  service.add(weigh('TX-NEW', 'REC-1', 100, '2026-09-05'));

  // 9 月费率已更新为 30，但把 8 月那笔更正为 120kg，必须仍按 25 结算。
  service.adjust({
    id: 'ADJ-1', type: 'correction', refId: 'TX-OLD',
    weightKg: 120, occurredAt: '2026-09-10T10:00:00+08:00',
  });

  const aug = service.settle('REC-1', '2026-08', 1_000_000);
  assert.equal(aug.lines[0].rateVersion, '2026.1');
  assert.equal(aug.lines[0].centsPerKg, 25);
  assert.equal(aug.totalCents, 3000); // 120 × 25

  const sep = service.settle('REC-1', '2026-09', 1_000_000);
  assert.equal(sep.lines[0].rateVersion, '2026.9');
  assert.equal(sep.totalCents, 3000); // 100 × 30
});

test('跨月度上限只截断超出部分，前序笔不受影响', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 300, '2026-08-01')); // 7500
  service.add(weigh('TX-2', 'REC-1', 200, '2026-08-02')); // 5000，额度仅剩 2500
  service.add(weigh('TX-3', 'REC-1', 50, '2026-08-03'));  // 1250，已无额度
  const batch = service.settle('REC-1', '2026-08', 10_000);

  assert.equal(batch.totalCents, 10_000);
  assert.equal(batch.lines[0].grantedCentsExact, '7500');
  assert.equal(batch.lines[0].capped, false);
  assert.equal(batch.lines[1].grantedCentsExact, '2500');
  assert.equal(batch.lines[1].truncatedCentsExact, '2500');
  assert.equal(batch.lines[1].capped, true);
  assert.equal(batch.lines[2].grantedCentsExact, '0');
  assert.equal(batch.lines[2].truncatedCentsExact, '1250');
  assert.equal(recomputeTotal(batch, 10_000), 10_000);
});

test('冲正事件幂等：重放不产生第二份影响、不再次消耗额度', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 600, '2026-08-01')); // 15000，受上限只给 10000
  service.add(weigh('TX-2', 'REC-1', 100, '2026-08-02')); // 2500，本应被上限挤掉

  const reversal = { id: 'ADJ-1', type: 'reversal', refId: 'TX-1', occurredAt: '2026-08-03T10:00:00+08:00' };
  assert.equal(service.adjust(reversal), true);
  assert.equal(service.adjust(reversal), false); // 同事件重放被识别，不重复记账

  const batch = service.settle('REC-1', '2026-08', 10_000);
  assert.equal(batch.lines[0].status, 'voided');
  assert.equal(batch.lines[0].grantedCentsExact, '0');
  // TX-1 撤销后额度函数式释放，TX-2 足额拿到 2500。
  assert.equal(batch.lines[1].grantedCentsExact, '2500');
  assert.equal(batch.totalCents, 2500);
});

test('边界重量与负向（下调）更正没有浮点漂移', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 3.33, '2026-09-01')); // 3.33 × 30 = 99.9
  service.adjust({
    id: 'ADJ-1', type: 'correction', refId: 'TX-1',
    weightKg: 1.11, occurredAt: '2026-09-02T10:00:00+08:00', // 下调为 1.11 × 30 = 33.3
  });
  const batch = service.settle('REC-1', '2026-09', 1_000_000);

  assert.equal(batch.lines[0].status, 'corrected');
  assert.equal(batch.lines[0].originalWeightKg, 3.33);
  assert.equal(batch.lines[0].weightKg, 1.11);
  assert.equal(batch.lines[0].amountCentsExact, '33.3');
  assert.equal(batch.totalCentsExact, '33.3');
  assert.equal(batch.totalCents, 33); // 33.3 末尾舍入
  assert.deepEqual(batch.lines[0].adjustmentChain, ['ADJ-1']);
});

test('先更正后撤销：冲正链以最后事件为准，金额归零', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 100, '2026-08-01'));
  service.adjust({ id: 'ADJ-1', type: 'correction', refId: 'TX-1', weightKg: 120, occurredAt: '2026-08-02T10:00:00+08:00' });
  service.adjust({ id: 'ADJ-2', type: 'reversal', refId: 'TX-1', occurredAt: '2026-08-03T10:00:00+08:00' });
  const batch = service.settle('REC-1', '2026-08', 10_000);
  assert.equal(batch.lines[0].status, 'voided');
  assert.equal(batch.totalCents, 0);
  assert.deepEqual(batch.lines[0].adjustmentChain, ['ADJ-1', 'ADJ-2']);
});

test('已公示批次冻结：费率表更新、重新结算结果不变', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 100, '2026-08-15'));
  const before = service.settle('REC-1', '2026-08', 10_000);
  const published = service.publish('REC-1', '2026-08', '2026-09-01T00:00:00+08:00');
  assert.equal(published.status, 'published');

  // 费率表再加入更高的新版本，且重新结算。
  service.rates = new RateBook([
    { version: '2026.1', material: 'pet-a', effectiveFrom: '2026-01-01', centsPerKg: 25 },
    { version: '2026.9', material: 'pet-a', effectiveFrom: '2026-09-01', centsPerKg: 30 },
    { version: '2026.20', material: 'pet-a', effectiveFrom: '2026-01-01', centsPerKg: 999 },
  ]);
  const again = service.settle('REC-1', '2026-08', 10_000);

  assert.deepEqual(again, published);
  assert.equal(again.totalCents, before.totalCents);
  assert.equal(again.lines[0].rateVersion, '2026.1');
  assert.equal(again.publishedAt, '2026-09-01T00:00:00+08:00');
});

test('多次生成同一批次只保留一个有效结果', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  service.add(weigh('TX-1', 'REC-1', 100, '2026-08-01'));
  const first = service.settle('REC-1', '2026-08', 10_000);

  // 草稿期补一笔后重新结算：key 不变，只有一个批次，结果为新值。
  service.add(weigh('TX-2', 'REC-1', 100, '2026-08-02'));
  const second = service.settle('REC-1', '2026-08', 10_000);
  assert.equal(store.getBatch('REC-1:2026-08').totalCents, second.totalCents);
  assert.equal(second.totalCents, 5000);
  assert.equal(second.lines.length, 2);

  service.publish('REC-1', '2026-08');
  service.add(weigh('TX-3', 'REC-1', 100, '2026-08-03'));
  const third = service.settle('REC-1', '2026-08', 10_000);
  // 公示后重算返回冻结原物，TX-3 不进入，仍是一个有效结果。
  assert.equal(third.totalCents, second.totalCents);
  assert.equal(third.lines.length, 2);
  assert.deepEqual(third.generatedFrom, second.generatedFrom);
});

test('混合精度批次统一到最大精度，末尾一次舍入', () => {
  const store = new SubsidyStore();
  const service = new SubsidyService(store, twoPeriodRates());
  // 8 月费率 25：整公斤 + 两笔 0.1kg 边界重量混排。
  service.add(weigh('TX-1', 'REC-1', 1, '2026-08-01'));    // 25.0
  service.add(weigh('TX-2', 'REC-1', 0.1, '2026-08-02'));  // 2.5
  service.add(weigh('TX-3', 'REC-1', 0.1, '2026-08-03'));  // 2.5
  const batch = service.settle('REC-1', '2026-08', 1_000_000);
  assert.equal(batch.totalCentsExact, '30');
  // 批次末尾舍入 = 30；逐笔舍入会把两笔 2.5 各抬到 3，错误得到 31。
  assert.equal(batch.totalCents, 30);
  assert.equal(recomputeTotal(batch, 1_000_000), batch.totalCents);
});
