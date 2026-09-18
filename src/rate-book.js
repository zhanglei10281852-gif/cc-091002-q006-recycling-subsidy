import { parseScaledInt, RATE_SCALE } from './decimal.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 费率按材料等级与生效日期分版本。核算时必须用 rateFor(material, occurredAt)
// 选取交易发生时有效的版本，这样旧批次与冲正都不会沿用本月新费率。
export class RateBook {
  #byMaterial = new Map();

  constructor(versions = []) {
    if (!Array.isArray(versions)) throw new TypeError('rate versions must be an array');
    this.versions = versions.map((version, index) => RateBook.#normalize(version, index));
    for (const version of this.versions) {
      const list = this.#byMaterial.get(version.material) ?? [];
      list.push(version);
      this.#byMaterial.set(version.material, list);
    }
    for (const list of this.#byMaterial.values()) {
      // 同一生效日期以发布后出现的版本为准
      list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : a.index - b.index));
    }
  }

  static #normalize(version, index) {
    if (!version || typeof version !== 'object') throw new TypeError('rate version must be an object');
    const { material, effectiveFrom, centsPerKg } = version;
    if (typeof material !== 'string' || material.length === 0) {
      throw new TypeError('rate version material must be a non-empty string');
    }
    if (typeof effectiveFrom !== 'string' || !DATE_RE.test(effectiveFrom)) {
      throw new TypeError(`effectiveFrom must be "YYYY-MM-DD", got ${effectiveFrom}`);
    }
    const milliCentsPerKg = parseScaledInt(centsPerKg, RATE_SCALE, `centsPerKg(${material}@${effectiveFrom})`);
    if (milliCentsPerKg < 0) throw new Error(`centsPerKg must not be negative for ${material}@${effectiveFrom}`);
    return { ...version, index, milliCentsPerKg };
  }

  // at 为交易发生时间（ISO 字符串，按业务日期比较）；at 为 null 时取最新版本。
  rateFor(material, at = null) {
    const list = this.#byMaterial.get(material);
    if (!list || list.length === 0) throw new Error(`no rate version registered for material "${material}"`);
    if (at == null) return list[list.length - 1];
    const day = String(at).slice(0, 10);
    let selected = null;
    for (const version of list) {
      if (version.effectiveFrom <= day) selected = version;
      else break;
    }
    if (!selected) throw new Error(`no rate version for material "${material}" effective on ${day}`);
    return selected;
  }

  current(material) {
    const list = this.#byMaterial.get(material);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }
}
