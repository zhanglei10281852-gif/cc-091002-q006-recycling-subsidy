import { parseScaledInt, WEIGHT_SCALE } from './decimal.js';

const OCCURRED_AT_RE = /^\d{4}-\d{2}-\d{2}/;

export class SubsidyStore {
  transactions = [];
  batches = new Map();
  #eventIds = new Set();
  #seq = 0;

  add(item) {
    if (!item || typeof item !== 'object') throw new TypeError('event must be an object');
    const { id } = item;
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('event.id must be a non-empty string');
    }
    // 事件重放：同一 id 只保留首次记录，不会再次消耗额度
    if (this.#eventIds.has(id)) return this.transactions.find((event) => event.id === id);
    if (typeof item.company !== 'string' || item.company.length === 0) {
      throw new TypeError(`event ${id}: company must be a non-empty string`);
    }
    if (typeof item.occurredAt !== 'string' || !OCCURRED_AT_RE.test(item.occurredAt) || Number.isNaN(Date.parse(item.occurredAt))) {
      throw new TypeError(`event ${id}: occurredAt must be an ISO date/time string`);
    }
    const type = item.type ?? (item.reversalOf != null ? 'reversal' : 'weighing');
    if (type === 'weighing') {
      if (typeof item.material !== 'string' || item.material.length === 0) {
        throw new TypeError(`event ${id}: material must be a non-empty string`);
      }
      if (parseScaledInt(item.weightKg, WEIGHT_SCALE, `weightKg(${id})`) < 0) {
        throw new Error(`event ${id}: weightKg must not be negative; use a reversal to correct a weighing`);
      }
    } else if (type === 'reversal') {
      if (typeof item.reversalOf !== 'string' || item.reversalOf.length === 0) {
        throw new TypeError(`event ${id}: reversal must reference an original transaction via reversalOf`);
      }
    } else {
      throw new Error(`event ${id}: unknown event type "${type}"`);
    }
    const stored = { ...structuredClone(item), type, seq: this.#seq++ };
    this.#eventIds.add(id);
    this.transactions.push(stored);
    return stored;
  }

  getBatch(key) {
    return this.batches.get(key);
  }

  saveBatch(key, batch) {
    // 同一批次只保留一个有效结果：已公示的批次原样保留
    const existing = this.batches.get(key);
    if (existing) return existing;
    const stored = structuredClone(batch);
    this.batches.set(key, stored);
    return stored;
  }

  // 在已公示批次中查找某企业的明细行（跨月冲正以此为依据）
  findBatchLine(company, predicate) {
    for (const batch of this.batches.values()) {
      if (batch.company !== company) continue;
      const line = batch.lines.find(predicate);
      if (line) return { batch, line };
    }
    return null;
  }
}
