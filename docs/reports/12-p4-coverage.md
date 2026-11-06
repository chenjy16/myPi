# P4-02 · 纯函数覆盖率核查（Phase 4 收口）

基准：`docs/V2-PHASE4-TASKS.md` P4-02「关键纯函数覆盖率 ≥90%」。

## 采集方法

使用 Node 22 内置 `--experimental-test-coverage`（不新增第三方依赖）：

```bash
node --experimental-transform-types --test \
     --experimental-test-coverage \
     --test-coverage-include='app/lib/**' \
     tests/*.test.ts
```

## 判定口径

「逐文件 ≥90%」按 **行覆盖率** 判定；分支/函数为参考。安全敏感模块（ssrf-guard、
crypto-box、condition-evaluator、shop-scope、scope-guard、retry-policy、
action-risk-policy、retention-policy、reconcile-policy）要求行覆盖 100%
或 ≥97%；一般纯函数核要求 ≥90%。

## 结果（Phase 4 K4 快照 · 2026-05）

| 模块 | Lines | Branch | Func | 备注 |
| --- | --- | --- | --- | --- |
| action-risk-policy.ts | 100.00% | 100.00% | 100.00% | 达标 |
| automation-compiler.ts | 97.39% | 84.62% | 100.00% | 达标 |
| condition-evaluator.ts | 100.00% | 100.00% | 100.00% | 达标 |
| condition-operators.ts | 100.00% | 86.87% | 100.00% | 达标 |
| crypto-box.ts | 100.00% | 100.00% | 100.00% | 达标 |
| event-normalizer.ts | 100.00% | 97.78% | 100.00% | 达标 |
| execution-log.ts | 100.00% | 100.00% | 100.00% | 达标 |
| execution-metrics.ts | 100.00% | 100.00% | 100.00% | 达标 |
| execution-retention.ts | 100.00% | 72.73% | 100.00% | 达标 |
| health-automation.ts | 100.00% | 100.00% | 100.00% | 达标 |
| loop-protector.ts | 100.00% | 91.67% | 100.00% | 达标 |
| reconcile-policy.ts | 100.00% | 94.74% | 100.00% | 达标 |
| retention-policy.ts | 97.14% | 92.86% | 100.00% | 达标 |
| retry-policy.ts | 100.00% | 100.00% | 100.00% | 达标 |
| scope-guard.ts | 100.00% | 100.00% | 100.00% | 达标 |
| shop-scope.ts | 100.00% | 100.00% | 100.00% | 达标 |
| ssrf-guard.ts | 98.69% | 83.08% | 100.00% | 达标（105–106 是 full-form IPv6 分支，覆盖需扩测试） |

计划中列出的 11 个纯核模块（evaluator / loop / retry / risk-policy /
ssrf-guard / compiler / normalizer / reconcile-policy / retention-policy /
shop-scope / scope-guard）**全部 ≥97% 行覆盖**，均满足「逐文件 ≥90%」的门槛。

## 遗留（诚实边界）

- **ssrf-guard 分支覆盖 83%**：IPv6 无 `::` 的完整形式（105–106）与
  少量 IPv4-mapped 边界组合未测；不影响功能正确性，但下轮迭代应
  补 3–4 个用例把分支也推到 ≥90%。已开 follow-up。
- **automation-compiler 分支覆盖 84.6%**：条件嵌套与 action target
  组合分支较多，行覆盖已 97%；分支补测列入下一里程碑。
- **UI 组件（scope-gap-banner.tsx 等）**：不在纯函数覆盖率范围，
  走集成路径（K4 · P4-01 场景 H）人工确认。

## 未新增依赖说明

`node:test` 与 `--experimental-test-coverage` 是 Node 22 内置；`--test-
coverage-include` 是 Node 22.3+ 的稳定标志，无需 c8/nyc/istanbul。
