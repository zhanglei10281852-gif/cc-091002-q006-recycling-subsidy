# 回收补贴核算

服务按照材料等级、业务日期和企业月度额度核算回收补贴。费率以版本形式发布，称重更正通过冲正记录表达，已经公示的批次保存其计算依据和汇总结果。

## 模块

- `src/decimal.js` — BigInt 定点十进制：重量、金额全程不经过浮点；四舍五入只在批次末尾发生一次。
- `src/rate-book.js` — 按业务发生日期选择当时生效的费率版本（`effectiveAt(material, onDate)`），也可按版本号取回（`byVersion`）。
- `src/subsidy-store.js` — 事件溯源存储：称重记录只追加，冲正事件（`correction` / `reversal`）按 id 幂等；`effectiveWeighings()` 由原始记录 + 冲正链函数式派生当前有效视图；批次分草稿/公示两态，公示后冻结。
- `src/subsidy-service.js` — 汇总核算。
- `fixtures/settlement.json` — 脱敏结算资料。

## 核算规则

1. 每笔原始重量按输入声明的精度解析为定点数，跨笔统一到批次最大精度，单笔**不**舍入；
2. 每笔金额 = 重量 × 业务发生当日生效费率，冲正（更正/撤销）仍引用原交易当时的费率版本，并把版本号与单价固化进批次明细；
3. 月度额度按业务时间顺序扣减，跨上限的金额**只截断超出部分**，前序笔不受影响；
4. 额度没有持久计数器，每次结算从称重与冲正链重算，冲正事件按 id 去重——事件重放不会再次消耗额度；
5. 批次末尾对合计金额做唯一一次四舍五入；
6. 已公示批次冻结：费率表更新或重新结算都原样返回旧结果，可随时复查；
7. 同一企业+月份始终只有一个批次结果（草稿可重算，公示后不可变）。

## 使用

```js
const service = new SubsidyService(new SubsidyStore(), new RateBook(rates));
service.add({ id: 'TX-1', company: 'REC-1', material: 'pet-a', weightKg: 0.1, occurredAt: '2026-09-10T09:00:00+08:00' });
service.adjust({ id: 'ADJ-1', type: 'correction', refId: 'TX-1', weightKg: 0.2, occurredAt: '2026-09-11T09:00:00+08:00' });
service.adjust({ id: 'ADJ-2', type: 'reversal', refId: 'TX-1', occurredAt: '2026-09-12T09:00:00+08:00' });
const batch = service.settle('REC-1', '2026-09', 10000); // 草稿，可重算
service.publish('REC-1', '2026-09');                     // 公示冻结
```

项目使用 Node.js 20 或更高版本，运行 `npm test` 检查核算规则。
