# 回收补贴核算

服务按照材料等级、业务日期和企业月度额度核算回收补贴。费率以版本形式发布，称重更正通过冲正记录表达，已经公示的批次保存其计算依据和汇总结果。

## 核算口径（与公示规则一致）

- **重量精度**：每笔原始重量先保留规定精度 0.001 kg（四舍五入到 milli-kg），内部一律用整数表示，边界重量没有浮点漂移。
- **统一舍入**：金额以 micro-cent（1e-6 分）的整数逐笔累计，**批次末尾统一舍入**——只对批次总额做一次四舍五入（按绝对值远离零方向）到分，不再逐笔四舍五入。
- **费率版本**：按材料等级 + 生效日期选取交易发生时有效的版本；同一材料同一生效日期以发布后出现的版本为准。
- **月度上限**：按发生时间顺序逐笔占用额度，跨上限的金额只对超出部分截断，剩余额度足额发放。
- **冲正**：称重的更正或撤销用冲正记录表达（`type: 'reversal'`，`reversalOf` 指向原交易）。冲正引用原交易当时的费率版本与实发金额（实发已含当时剩余额度的截断），并在冲正发生月释放等额额度；同一笔称重只能被冲正一次，跨月冲正以已公示批次中的明细为准。
- **幂等**：事件按 `id` 去重，事件重放不会再次消耗额度；同一 `company:month` 批次只保留一个有效结果，重复结算返回已公示批次。
- **批次不变性**：已公示批次原样复查，不随费率版本更新而变化。

## 批次结构

`settle(company, month, capCents)` 返回的批次包含：

- `lines[]`：逐笔计算依据——`weightMilliKg`、`rateVersion`、`centsPerKg`、`amountMicroCents`（名义金额）、`truncatedMicroCents`（被上限截断部分）、`grantedMicroCents`（实发，冲正为负）。
- `totalMicroCents`：逐笔实发之和（精确值）。
- `totalCents`：批次总额，由 `totalMicroCents` 统一舍入到分。

企业复查：`sum(lines[].grantedMicroCents) === totalMicroCents`，对总额做一次四舍五入即得 `totalCents`，明细可完整算回批次总额。

## 运行

项目使用 Node.js 20 或更高版本，运行 `npm test` 执行全部测试。

`src/decimal.js` 提供定点十进制运算，`src/rate-book.js` 选择费率版本，`src/subsidy-service.js` 汇总交易，`src/subsidy-store.js` 保存事件与批次，`fixtures/settlement.json` 提供脱敏结算资料。
