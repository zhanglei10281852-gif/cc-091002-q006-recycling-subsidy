// 费率表：同一材料按 effectiveFrom 形成版本序列。
// 结算时按业务发生日期选择当时生效的版本，绝不使用"当前最新费率"，
// 这样已公示的旧批次不会随费率更新而变化。

export class RateBook {
  constructor(versions) {
    // 按材料分组并按生效日期升序排列，便于二分/倒序查找。
    this.byMaterial = new Map();
    for (const v of versions) {
      if (!this.byMaterial.has(v.material)) this.byMaterial.set(v.material, []);
      this.byMaterial.get(v.material).push(v);
    }
    for (const list of this.byMaterial.values()) {
      list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    }
  }

  /**
   * 取某材料在指定业务日期（YYYY-MM-DD 或 ISO 时间戳）当时生效的费率版本。
   * @param {string} material
   * @param {string} onDate 业务发生时间，取其日期部分
   * @returns 费率版本对象（含 version / centsPerKg）
   */
  effectiveAt(material, onDate) {
    const day = onDate.slice(0, 10);
    const list = this.byMaterial.get(material) ?? [];
    // 倒序找第一个生效日不晚于业务日的版本。
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].effectiveFrom <= day) return list[i];
    }
    throw new Error(`材料 ${material} 在 ${day} 没有生效费率`);
  }

  /**
   * 按版本号取回费率（冲正记录引用原交易当时的费率版本时使用）。
   */
  byVersion(version) {
    for (const list of this.byMaterial.values()) {
      const hit = list.find((v) => v.version === version);
      if (hit) return hit;
    }
    throw new Error(`费率版本不存在: ${version}`);
  }
}
