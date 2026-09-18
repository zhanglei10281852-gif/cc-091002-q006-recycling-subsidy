import { parseScaledInt, roundDiv, WEIGHT_SCALE, MONEY_SCALE, MICRO_CENTS_PER_CENT } from './decimal.js';

const MONTH_RE = /^\d{4}-\d{2}$/;
const NO_CAP = Infinity;

// 核算口径（与公示规则一致）：
// - 每笔原始重量先保留规定精度（0.001 kg），金额以 micro-cent 整数逐笔累计；
// - 批次末尾统一舍入：只对批次总额做一次四舍五入到分，不逐笔四舍五入；
// - 月度上限按发生顺序占用，跨上限的金额只对超出部分截断；
// - 冲正引用原交易当时的费率版本与实发金额（已含当时剩余额度的截断），
//   并在冲正发生月释放等额额度；同一笔称重只能被冲正一次；
// - 已公示批次原样复查：重复结算返回既有批次，不随费率更新变化。
export class SubsidyService {
  constructor(store, rates) {
    this.store = store;
    this.rates = rates;
  }

  add(item) {
    return this.store.add(item);
  }

  getBatch(company, month) {
    return this.store.getBatch(`${company}:${month}`);
  }

  settle(company, month, capCents = null) {
    if (!MONTH_RE.test(month)) throw new Error(`month must be "YYYY-MM", got "${month}"`);
    const key = `${company}:${month}`;
    // 多次生成同一批次只保留一个有效结果，已公示批次不随费率更新变化
    const published = this.store.getBatch(key);
    if (published) return published;

    const capMicro = capCents == null ? NO_CAP : parseScaledInt(capCents, MONEY_SCALE, 'capCents');
    if (capMicro < 0) throw new Error('capCents must not be negative');

    const events = this.store.transactions
      .filter((event) => event.company === company && event.occurredAt.startsWith(month))
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.seq - b.seq);

    const lines = [];
    const weighingById = new Map();
    const reversedIds = new Set();
    let usedMicro = 0;

    for (const event of events) {
      const line = event.type === 'reversal'
        ? this.#reversalLine(company, event, weighingById, reversedIds)
        : this.#weighingLine(event, capMicro === NO_CAP ? NO_CAP : capMicro - usedMicro);
      usedMicro += line.grantedMicroCents;
      lines.push(line);
      if (line.type === 'weighing') weighingById.set(line.id, line);
    }

    const totalMicroCents = lines.reduce((sum, line) => sum + line.grantedMicroCents, 0);
    const batch = {
      id: key,
      company,
      month,
      monthlyCapCents: capCents ?? null,
      basis: {
        weightPrecisionKg: '0.001',
        amountUnit: 'micro-cent (1e-6 cent)',
        lineRounding: 'none — lines keep exact precision',
        totalRounding: 'half away from zero, applied once to the batch total',
        capRule: 'only the excess over the remaining monthly cap is truncated',
        reversalRule: "reversals reuse the original line's rate version and granted amount",
      },
      lines,
      totalMicroCents,
      totalCents: roundDiv(totalMicroCents, MICRO_CENTS_PER_CENT),
    };
    return this.store.saveBatch(key, batch);
  }

  #weighingLine(event, remainingMicro) {
    const rate = this.rates.rateFor(event.material, event.occurredAt);
    const weightMilliKg = parseScaledInt(event.weightKg, WEIGHT_SCALE, `weightKg(${event.id})`);
    const amountMicro = weightMilliKg * rate.milliCentsPerKg;
    // 跨上限只对超出部分截断，剩余额度足额发放
    const grantedMicro = remainingMicro === NO_CAP ? amountMicro : Math.min(amountMicro, Math.max(0, remainingMicro));
    return {
      ...event,
      weightKg: weightMilliKg / 1000,
      weightMilliKg,
      rateVersion: rate.version,
      rateEffectiveFrom: rate.effectiveFrom,
      centsPerKg: rate.centsPerKg,
      rateMilliCentsPerKg: rate.milliCentsPerKg,
      amountMicroCents: amountMicro,
      truncatedMicroCents: amountMicro - grantedMicro,
      grantedMicroCents: grantedMicro,
    };
  }

  #reversalLine(company, event, weighingById, reversedIds) {
    // 同月原交易取本次计算结果，跨月原交易以已公示批次为准
    const original = weighingById.get(event.reversalOf)
      ?? this.store.findBatchLine(company, (line) => line.type === 'weighing' && line.id === event.reversalOf)?.line;
    if (!original) {
      throw new Error(`reversal ${event.id} references unknown weighing ${event.reversalOf}; settle the original month first`);
    }
    const alreadyReversed = reversedIds.has(original.id)
      || this.store.findBatchLine(company, (line) => line.type === 'reversal' && line.reversalOf === original.id);
    if (alreadyReversed) throw new Error(`weighing ${original.id} is already reversed`);
    reversedIds.add(original.id);
    // 引用原交易当时的费率与实发金额（实发已含当时剩余额度的截断）
    return {
      ...event,
      material: original.material,
      rateVersion: original.rateVersion,
      rateEffectiveFrom: original.rateEffectiveFrom,
      centsPerKg: original.centsPerKg,
      rateMilliCentsPerKg: original.rateMilliCentsPerKg,
      amountMicroCents: -original.amountMicroCents,
      truncatedMicroCents: -original.truncatedMicroCents,
      grantedMicroCents: -original.grantedMicroCents,
    };
  }
}
