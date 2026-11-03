import type { ReactNode } from "react";

export type Fact = { label: string; value: ReactNode };

/**
 * 只读事实卡网格（spec §8.4 的 key/value 呈现）。全部由 Polaris 原语组合而成
 * （s-grid + s-box + s-text + s-paragraph），不引入任何新样式类——这样设置页、
 * 首页的“当前配置”区和库存页的指标区说的是同一种语言。
 * 值一律由调用方传入已格式化好的节点（格式化仍走 app/lib/format）。
 */
export function FactGrid({
  facts,
  minColumnWidth = 220,
}: {
  facts: Fact[];
  minColumnWidth?: number;
}) {
  return (
    <s-grid
      gridTemplateColumns={`repeat(auto-fit, minmax(${minColumnWidth}px, 1fr))`}
      gap="base"
    >
      {facts.map((fact) => (
        <s-box
          key={fact.label}
          padding="base"
          background="subdued"
          borderRadius="base"
        >
          <s-stack direction="block" gap="small">
            <s-paragraph>{fact.label}</s-paragraph>
            <s-text type="strong">{fact.value}</s-text>
          </s-stack>
        </s-box>
      ))}
    </s-grid>
  );
}
