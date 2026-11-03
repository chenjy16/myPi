import { useCallback, useEffect, useRef } from "react";
import {
  PAGE_SIZES,
  SORT_KEYS,
  SORT_LABELS,
  type SortDirection,
  type SortKey,
} from "../../lib/table-view";

/**
 * 数据表格的工具条族（spec §5.2 / §8.2）：搜索、排序、每页条数、分页。
 * 全部是呈现层组件，不含任何业务计算；值一律由父级以 props 传入、以回调回传，
 * 所以同一套控件可以被 Replenishment 之外的列表页直接复用。
 *
 * 为什么显式 addEventListener：Polaris Web Components 由 Shopify 后台宿主注入，
 * React 18 对自定义元素的事件代理并不可靠（不冒泡就收不到），因此直接监听宿主元素，
 * 这是全站唯一一处这类绑定。值只从宿主 `.value` 读，不从 event.target 猜。
 */
type HostWithValue = { value?: string };

function readHostValue(node: Element | null): string {
  return node ? ((node as unknown as HostWithValue).value ?? "") : "";
}

function useHostValue(
  getHost: () => Element | null,
  value: string,
  onValue: (next: string) => void,
): void {
  const typed = useRef(value);
  // 回调走 ref 转发：调用方几乎都传内联箭头函数，若不这样每帧都会重挂监听器。
  const emit = useRef(onValue);

  useEffect(() => {
    emit.current = onValue;
  }, [onValue]);

  useEffect(() => {
    const node = getHost();
    if (!node) return;
    const handle = () => {
      const next = readHostValue(node);
      typed.current = next;
      emit.current(next);
    };
    // 搜索框可能只派发其中一种，三种都绑、同一处理函数，幂等无副作用。
    for (const type of ["input", "change", "search"]) {
      node.addEventListener(type, handle);
    }
    return () => {
      for (const type of ["input", "change", "search"]) {
        node.removeEventListener(type, handle);
      }
    };
  }, [getHost]);

  // 只有外部改写（清空搜索、重置筛选）才回写宿主，正在输入的字符不打断。
  useEffect(() => {
    const node = getHost();
    if (!node) return;
    if (value !== typed.current) {
      (node as unknown as HostWithValue).value = value;
      typed.current = value;
    }
  }, [getHost, value]);
}

/** 关键词搜索框：命中商品名 / 变体名 / SKU，带清空入口。 */
export function TableSearchField({
  value,
  onValueChange,
  label = "Search this list",
  placeholder = "Product, variant or SKU",
}: {
  value: string;
  onValueChange: (next: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const getHost = useCallback(
    () => host.current?.querySelector("s-search-field") ?? null,
    [],
  );
  useHostValue(getHost, value, onValueChange);

  return (
    <div className="dsToolbarField" ref={host}>
      <s-search-field label={label} placeholder={placeholder} />
      {value ? (
        <s-button variant="tertiary" onClick={() => onValueChange("")}>
          Clear
        </s-button>
      ) : null}
    </div>
  );
}

/** 排序列 + 方向：方向用文字表述，不靠箭头图标单独承载含义。 */
export function TableSortControl({
  sort,
  direction,
  onSortChange,
  onDirectionChange,
}: {
  sort: SortKey;
  direction: SortDirection;
  onSortChange: (next: SortKey) => void;
  onDirectionChange: (next: SortDirection) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const getHost = useCallback(
    () => host.current?.querySelector("s-select") ?? null,
    [],
  );
  useHostValue(getHost, sort, (next) =>
    onSortChange((SORT_KEYS as readonly string[]).includes(next) ? (next as SortKey) : sort),
  );

  return (
    <div className="dsToolbarGroup" ref={host}>
      <s-select label="Sort by" value={sort}>
        {SORT_KEYS.map((key) => (
          <s-option key={key} value={key} selected={key === sort}>
            {SORT_LABELS[key]}
          </s-option>
        ))}
      </s-select>
      <s-button
        variant="secondary"
        onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
      >
        {direction === "asc" ? "Ascending" : "Descending"}
      </s-button>
    </div>
  );
}

/** 每页条数。 */
export function TablePageSizeControl({
  pageSize,
  onPageSizeChange,
}: {
  pageSize: number;
  onPageSizeChange: (next: number) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const getHost = useCallback(
    () => host.current?.querySelector("s-select") ?? null,
    [],
  );
  useHostValue(getHost, String(pageSize), (next) => {
    const parsed = Number(next);
    if ((PAGE_SIZES as readonly number[]).includes(parsed)) onPageSizeChange(parsed);
  });

  return (
    <div className="dsToolbarField" ref={host}>
      <s-select label="Rows per page" value={String(pageSize)}>
        {PAGE_SIZES.map((size) => (
          <s-option key={size} value={String(size)} selected={size === pageSize}>
            {size}
          </s-option>
        ))}
      </s-select>
    </div>
  );
}

/**
 * 分页条：上一页 / 下一页 + 「第几页、共多少条」的文字说明。
 * 结果计数用 aria-live 播报，搜索后读屏用户不用重新 Tab 一遍才知道命中了多少行。
 */
export function TablePagination({
  page,
  totalPages,
  totalRows,
  firstIndex,
  lastIndex,
  noun = "variants",
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalRows: number;
  firstIndex: number;
  lastIndex: number;
  noun?: string;
  onPageChange: (next: number) => void;
}) {
  return (
    <div className="dsToolbarPagination">
      <s-button
        variant="secondary"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </s-button>
      <s-button
        variant="secondary"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </s-button>
      <span className="dsToolbarCount" role="status" aria-live="polite">
        {totalRows === 0
          ? `No ${noun} match the current filters`
          : `Showing ${firstIndex}–${lastIndex} of ${totalRows} ${noun} · page ${page} of ${totalPages}`}
      </span>
    </div>
  );
}

/** 无匹配结果时的统一说明 + 一键清空（spec §9：空状态必须给出下一步）。 */
export function TableNoResultsHint({
  search,
  onReset,
}: {
  search: string;
  onReset: () => void;
}) {
  return (
    <div className="dsToolbarReset">
      <s-paragraph>
        {search
          ? `Nothing matches “${search}” in this view.`
          : "Nothing is in this state right now."}
      </s-paragraph>
      {search ? (
        <s-button variant="tertiary" onClick={onReset}>
          Clear search
        </s-button>
      ) : null}
    </div>
  );
}
