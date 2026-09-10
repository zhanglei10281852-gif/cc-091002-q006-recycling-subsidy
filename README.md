# 回收补贴核算

服务按照材料等级、业务日期和企业月度额度核算回收补贴。费率以版本形式发布，称重更正通过冲正记录表达，已经公示的批次保存其计算依据和汇总结果。

`src/rate-book.js` 选择费率，`src/subsidy-service.js` 汇总交易，`fixtures/settlement.json` 提供脱敏结算资料。项目使用 Node.js 20 或更高版本，运行 `npm test` 可以检查整公斤交易的基础结果。
