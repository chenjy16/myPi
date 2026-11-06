// 带扩展名是故意的：本文件要能被 `node --test` 直接加载（与同目录纯模块同一约定）。
// 纯逻辑：Condition Evaluator（PRD §19）——一层 AND/OR 组合、白名单前置、逐条明细产出。
// 明细进 ExecutionLog.conditionResult，供 Activity Logs 商家回看「为什么没触发/为什么触发」；
// 确定性铁律（P2）：相同输入 + 相同编译版本 ⇒ 相同结果，本模块不自取时钟、不碰网络、无副作用。
//
// 字段访问（P2-05）：点路径只在 StandardEvent.data 内解析——条件判据只能消费归一层
// 已验证的安全字段，杜绝运行时回读原始 payload 引入的形状漂移。
// 日期比较按绝对时间戳进行，与时区无关；商家时区（Shop.timezone）只影响 Phase 3 的展示归一，
// 不参与求值，避免同一事件在不同时区判出不同结果的不确定性。
import {
  evaluateOperator,
  type ConditionOperatorName,
  type ConditionOperandType,
} from "./condition-operators.ts";
import type { StandardEvent } from "./event-normalizer.ts";

export type CompiledClause = {
  field: string;
  op: ConditionOperatorName;
  value: unknown;
  type: ConditionOperandType;
};

export type CompiledConditions = {
  logic: "AND" | "OR";
  clauses: readonly CompiledClause[];
};

export type ClauseEvaluation = {
  field: string;
  op: string;
  expected: unknown;
  /** 白名单外字段不取值，置 undefined 并标 invalidField。 */
  actual: unknown;
  pass: boolean;
  invalidField?: boolean;
};

export type EvaluationResult = {
  result: boolean;
  logic: "AND" | "OR";
  clauses: ClauseEvaluation[];
};

/** 点路径取值：任一段缺失即 undefined，绝不抛（缺字段走空值规则）。 */
export function fieldValueAt(data: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = data;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      // 数组段访问（如 tags.0）也支持，其余容器外形态一律取不到
      if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
        cursor = (cursor as unknown[])[Number(segment)];
        continue;
      }
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * 求值一组条件。conditions 缺省（undefined/无 clauses）视作无条件 ⇒ result:true。
 * whitelist 为 P2-01 Trigger Registry 的字段白名单：越界字段该 clause 判 false 并标
 * invalidField，整体不误执行、不 crash——这是商家手改/旧版 DSL 残留字段时的安全垫。
 */
export function evaluateConditions(
  conditions: CompiledConditions | undefined,
  event: StandardEvent,
  whitelist: ReadonlySet<string>,
): EvaluationResult {
  const logic = conditions?.logic ?? "AND";
  const clauses = conditions?.clauses ?? [];
  if (clauses.length === 0) return { result: true, logic, clauses: [] };

  const details: ClauseEvaluation[] = clauses.map((clause) => {
    if (!whitelist.has(clause.field)) {
      return {
        field: clause.field,
        op: clause.op,
        expected: clause.value,
        actual: undefined,
        pass: false,
        invalidField: true,
      };
    }
    const actual = fieldValueAt(event.data, clause.field);
    return {
      field: clause.field,
      op: clause.op,
      expected: clause.value,
      actual,
      pass: evaluateOperator(clause.op, actual, clause.value, clause.type),
    };
  });

  const result =
    logic === "OR"
      ? details.some((d) => d.pass)
      : details.every((d) => d.pass);
  return { result, logic, clauses: details };
}
