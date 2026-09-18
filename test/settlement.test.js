import test from 'node:test';
import assert from 'node:assert/strict';
import { RateBook } from '../src/rate-book.js';
import { SubsidyStore } from '../src/subsidy-store.js';
import { SubsidyService } from '../src/subsidy-service.js';

const V1 = { version: '2026.1', material: 'pet-a', effectiveFrom: '2026-01-01', centsPerKg: 25 };
const V2 = { version: '2026.2', material: 'pet-a', effectiveFrom: '2026-09-15', centsPerKg: 30 };

const setup = (versions = [V1]) => {
  const store = new SubsidyStore();
  return { store, service: new SubsidyService(store, new RateBook(versions)) };
};
const weighing = (id, weightKg, day, company = 'C1') => ({
  id, company, material: 'pet-a', weightKg, occurredAt: `2026-09-${String(day).padStart(2, '0')}T08:00:00+08:00`,
});
const reversal = (id, reversalOf, occurredAt, company = 'C1') => ({ id, company, type: 'reversal', reversalOf, occurredAt });

test('批次末尾统一舍入，不再逐笔四舍五入', () => {
  const { service } = setup();
  for (let i = 1; i <= 3; i++) service.add(weighing(`W${i}`, 0.5, i));
  const batch = service.settle('C1', '2026-09', 100000);
  // 每笔 0.5kg × 25分 = 12.5分；逐笔四舍五入会得到 13×3=39，正确口径是 37.5 → 38
  assert.deepEqual(batch.lines.map((l) => l.grantedMicroCents), [12_500_000, 12_500_000, 12_500_000]);
  assert.equal(batch.totalMicroCents, 37_500_000);
  assert.equal(batch.totalCents, 38);
});

test('费率按交易发生时的生效版本选择', () => {
  const { service } = setup([V1, V2]);
  service.add(weighing('A', 10, 10));
  service.add(weighing('B', 10, 20));
  const batch = service.settle('C1', '2026-09', 100000);
  assert.equal(batch.lines[0].rateVersion, '2026.1');
  assert.equal(batch.lines[1].rateVersion, '2026.2');
  assert.equal(batch.totalCents, 250 + 300);
});

test('冲正引用原交易当时的费率，而不是冲正当月的新费率', () => {
  const { service } = setup([V1, V2]);
  service.add(weighing('A', 100, 10));
  service.add(reversal('R1', 'A', '2026-09-20T08:00:00+08:00'));
  const batch = service.settle('C1', '2026-09', 100000);
  const line = batch.lines[1];
  assert.equal(line.type, 'reversal');
  assert.equal(line.rateVersion, '2026.1');
  assert.equal(line.grantedMicroCents, -2_500_000_000);
  assert.equal(batch.totalCents, 0);
});

test('更正链：撤销原称重后按新记录核算，额度随之释放', () => {
  const { service } = setup();
  service.add(weighing('A', 100, 10));
  service.add(reversal('R1', 'A', '2026-09-11T08:00:00+08:00'));
  service.add(weighing('B', 80, 12));
  const batch = service.settle('C1', '2026-09', 2500);
  // 若冲正不释放额度，cap 2500 已被占满，B 只能得 0
  assert.equal(batch.lines[2].grantedMicroCents, 2_000_000_000);
  assert.equal(batch.totalCents, 2000);
});

test('跨上限的金额只对超出部分截断', () => {
  const { service } = setup();
  service.add(weighing('A', 30, 1)); // 750 分，足额
  service.add(weighing('B', 20, 2)); // 500 分，只剩 250 额度
  service.add(weighing('C', 10, 3)); // 额度已用完
  const batch = service.settle('C1', '2026-09', 1000);
  assert.equal(batch.lines[0].grantedMicroCents, 750_000_000);
  assert.equal(batch.lines[1].grantedMicroCents, 250_000_000);
  assert.equal(batch.lines[1].truncatedMicroCents, 250_000_000);
  assert.equal(batch.lines[2].grantedMicroCents, 0);
  assert.equal(batch.totalCents, 1000);
});

test('截断与负向调整精确到微分，无浮点漂移', () => {
  const { service } = setup();
  service.add(weighing('A', 1.234, 1)); // 30.85 分，上限 30 分
  const batch = service.settle('C1', '2026-09', 30);
  assert.equal(batch.lines[0].amountMicroCents, 30_850_000);
  assert.equal(batch.lines[0].grantedMicroCents, 30_000_000);
  assert.equal(batch.lines[0].truncatedMicroCents, 850_000);
  assert.equal(batch.totalCents, 30);
});

test('边界重量先保留规定精度（0.001 kg），无浮点漂移', () => {
  const { service } = setup();
  service.add(weighing('A', 2.675, 1)); // 经典浮点边界值
  service.add(weighing('B', 0.0005, 2)); // 恰好半个规定精度，入为 0.001 kg
  service.add(weighing('C', 1.2345, 3)); // 第四位小数五入
  const batch = service.settle('C1', '2026-09', 100000);
  assert.equal(batch.lines[0].weightMilliKg, 2675);
  assert.equal(batch.lines[1].weightMilliKg, 1);
  assert.equal(batch.lines[2].weightMilliKg, 1235);
  // (2675 + 1 + 1235) milli-kg × 25 分 = 97.775 分 → 98
  assert.equal(batch.totalMicroCents, 97_775_000);
  assert.equal(batch.totalCents, 98);
});

test('跨月冲正引用已公示批次的实发金额与原费率', () => {
  const { service } = setup([V1, V2]);
  service.add(weighing('A', 60, 10)); // 1500 分，上限 1000，实发 1000
  const sept = service.settle('C1', '2026-09', 1000);
  assert.equal(sept.totalCents, 1000);
  service.add(reversal('R1', 'A', '2026-10-02T08:00:00+08:00'));
  const oct = service.settle('C1', '2026-10', 1000);
  // 冲正金额是实发 1000（含当时剩余额度截断），不是名义 1500，费率仍是 2026.1
  assert.equal(oct.lines[0].rateVersion, '2026.1');
  assert.equal(oct.lines[0].grantedMicroCents, -1_000_000_000);
  assert.equal(oct.totalCents, -1000);
  // 已公示的 9 月批次原样复查
  assert.equal(service.settle('C1', '2026-09', 1000).totalCents, 1000);
});

test('负向调整的舍入按绝对值远离零方向', () => {
  const { service } = setup();
  service.add(weighing('A', 0.5, 10)); // 12.5 分
  assert.equal(service.settle('C1', '2026-09', 1000).totalCents, 13);
  service.add(reversal('R1', 'A', '2026-10-02T08:00:00+08:00'));
  const oct = service.settle('C1', '2026-10', 1000);
  assert.equal(oct.totalMicroCents, -12_500_000);
  assert.equal(oct.totalCents, -13); // 与 9 月公示的 13 正好对冲
});

test('事件重放不会再次消耗额度，重复结算幂等', () => {
  const { store, service } = setup();
  const event = weighing('A', 40, 10);
  service.add(event);
  service.add(event);
  service.add({ ...event });
  assert.equal(store.transactions.length, 1);
  const first = service.settle('C1', '2026-09', 1000);
  const second = service.settle('C1', '2026-09', 1000);
  assert.equal(store.batches.size, 1);
  assert.deepEqual(second, first);
  assert.equal(first.totalCents, 1000);
});

test('已公示批次不随费率更新变化', () => {
  const store = new SubsidyStore();
  const before = new SubsidyService(store, new RateBook([V1]));
  before.add(weighing('A', 100, 10));
  assert.equal(before.settle('C1', '2026-09', 10000).totalCents, 2500);
  // 费率表更新后（含回溯生效的版本），旧批次复查结果不变
  const after = new SubsidyService(store, new RateBook([V1, { version: '2026.3', material: 'pet-a', effectiveFrom: '2026-09-01', centsPerKg: 99 }]));
  const recheck = after.settle('C1', '2026-09', 10000);
  assert.equal(recheck.totalCents, 2500);
  assert.equal(recheck.lines[0].rateVersion, '2026.1');
});

test('企业明细可以从称重、费率版本和冲正链算回批次总额', () => {
  const { service } = setup();
  service.add(weighing('A', 0.5, 1)); // 12.5 分
  service.add(weighing('B', 40, 2)); // 1000 分，被上限截断
  service.add(reversal('R1', 'A', '2026-09-03T08:00:00+08:00'));
  const batch = service.settle('C1', '2026-09', 1000);
  assert.equal(batch.lines[1].truncatedMicroCents, 12_500_000);
  const recomputedMicro = batch.lines.reduce((sum, line) => sum + line.grantedMicroCents, 0);
  assert.equal(recomputedMicro, batch.totalMicroCents);
  assert.equal(batch.totalMicroCents, 987_500_000);
  assert.equal(batch.totalCents, 988);
});

test('悬空冲正与重复冲正都会报错', () => {
  const { service } = setup();
  service.add(reversal('R9', 'NOPE', '2026-09-05T08:00:00+08:00'));
  assert.throws(() => service.settle('C1', '2026-09', 1000), /unknown weighing/);

  const again = setup();
  again.service.add(weighing('A', 10, 1));
  again.service.add(reversal('R1', 'A', '2026-09-02T08:00:00+08:00'));
  again.service.add(reversal('R2', 'A', '2026-09-03T08:00:00+08:00'));
  assert.throws(() => again.service.settle('C1', '2026-09', 1000), /already reversed/);
});

test('无有效费率版本时给出明确错误', () => {
  const { service } = setup([{ version: '2026.2', material: 'pet-a', effectiveFrom: '2026-10-01', centsPerKg: 30 }]);
  service.add(weighing('A', 10, 10));
  assert.throws(() => service.settle('C1', '2026-09', 1000), /no rate version/);
});
