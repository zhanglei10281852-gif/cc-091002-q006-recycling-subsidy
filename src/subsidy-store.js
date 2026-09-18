// 存储层：称重记录只追加，更正/撤销以冲正事件表达（事件溯源）。
// 派生结果一律由事件链函数式重算得到，因此事件重放不会再次消耗额度。
// 已公示（published）批次冻结，重复生成同一批次只保留一个有效结果。

export class SubsidyStore {
  /** 原始称重记录 id -> 记录（不可变） */
  #weighings = new Map();
  /** 冲正事件，按到达顺序追加 */
  #adjustments = [];
  #adjustmentIds = new Set();
  /** 批次 key -> { status: 'draft' | 'published', ... } */
  #batches = new Map();

  /** 兼容旧接口：直接加入一笔称重记录。 */
  add(item) {
    this.addWeighing(item);
  }

  addWeighing(record) {
    if (this.#weighings.has(record.id)) {
      throw new Error(`称重记录重复: ${record.id}`);
    }
    this.#weighings.set(record.id, structuredClone(record));
  }

  getWeighing(id) {
    const r = this.#weighings.get(id);
    return r ? structuredClone(r) : undefined;
  }

  /**
   * 登记一笔冲正事件。
   * - { type: 'reversal', refId }：整笔撤销
   * - { type: 'correction', refId, weightKg }：重量更正为新值（可大可小，小即负向调整）
   * 事件按自身 id 幂等：重放同一事件不会产生第二份影响。
   * 返回 true 表示本次实际登记，false 表示该事件此前已处理过。
   */
  applyAdjustment(event) {
    if (this.#adjustmentIds.has(event.id)) return false;
    if (!this.#weighings.has(event.refId)) {
      throw new Error(`冲正引用了不存在的称重记录: ${event.refId}`);
    }
    if (event.type !== 'reversal' && event.type !== 'correction') {
      throw new Error(`未知冲正类型: ${event.type}`);
    }
    this.#adjustmentIds.add(event.id);
    this.#adjustments.push(structuredClone(event));
    return true;
  }

  get adjustments() {
    return this.#adjustments.map((e) => structuredClone(e));
  }

  /**
   * 由原始称重 + 冲正链派生当前有效的称重视图。
   * 同一原交易被多次冲正时，后发生的事件为准。
   * 返回 { id, company, material, weightKg, occurredAt, status, chain }。
   */
  effectiveWeighings() {
    const latest = new Map(); // refId -> 最后一笔冲正事件
    for (const ev of this.#adjustments) {
      const prev = latest.get(ev.refId);
      if (!prev || ev.occurredAt >= prev.occurredAt) latest.set(ev.refId, ev);
    }
    const out = [];
    for (const [id, record] of this.#weighings) {
      const adj = latest.get(id);
      const chain = this.#adjustments
        .filter((e) => e.refId === id)
        .map((e) => e.id);
      if (!adj) {
        out.push({ ...structuredClone(record), status: 'active', chain });
      } else if (adj.type === 'reversal') {
        out.push({ ...structuredClone(record), weightKg: 0, status: 'voided', chain, adjustmentId: adj.id });
      } else {
        out.push({
          ...structuredClone(record),
          weightKg: adj.weightKg,
          status: 'corrected',
          chain,
          adjustmentId: adj.id,
        });
      }
    }
    return out;
  }

  /**
   * 保存批次。已公示批次冻结：任何重新生成的请求都返回原批次、原样不动；
   * 草稿批次允许被同 key 的新结果替换，因此同一批次始终只有一个有效结果。
   */
  saveBatch(key, batch) {
    const existing = this.#batches.get(key);
    if (existing?.status === 'published') return structuredClone(existing);
    this.#batches.set(key, { ...structuredClone(batch), status: 'draft' });
    return structuredClone(this.#batches.get(key));
  }

  getBatch(key) {
    const b = this.#batches.get(key);
    return b ? structuredClone(b) : undefined;
  }

  /** 公示批次：此后该批次计算依据与汇总结果冻结，可随时原样复查。 */
  publishBatch(key, at = new Date().toISOString()) {
    const b = this.#batches.get(key);
    if (!b) throw new Error(`批次不存在: ${key}`);
    b.status = 'published';
    b.publishedAt = at;
    return structuredClone(b);
  }
}
