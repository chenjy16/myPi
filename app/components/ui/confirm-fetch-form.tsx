import { useId, useRef, type FormEvent, type ReactNode } from "react";
import type { FetcherWithComponents } from "react-router";

/**
 * 破坏性/不可逆操作的共享确认表单（design-system.md §5）。
 *
 * 为什么不用 Polaris s-modal：@shopify/polaris-types 在 React 侧的 modal 打开/
 * 触发语义依赖宿主事件，本仓已多次验证 React 18 对自定义元素事件代理不可靠
 * （见 table 工具族的 .value 直读注释）。原生 <dialog> + showModal 行为确定、
 * 自带焦点管理与 Esc 关闭，是此时最稳的覆盖层原语；样式全部取自 tokens。
 *
 * 行为契约：
 * - 表单提交先被拦截、弹出确认框；确认后才真正走 fetcher 提交 —— 页面的
 *   intent / planId / formKey 分桶反馈机制原样保留，action 侧零感知。
 * - 取消 / Esc / 点遮罩外：不提交，表单保持原样。
 * - danger 确认按钮用 tone="critical"（s-button 没有 variant="danger"）。
 */

export type ConfirmRequest = {
  /** 弹窗标题：说清「要做什么」。 */
  heading: string;
  /** 弹窗正文：说清后果与可逆性，禁止空泛措辞。 */
  body: ReactNode;
  /** 确认按钮文案，用动词开头（"Delete supplier"）。 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 不可逆/破坏性操作：确认按钮染成 critical。 */
  danger?: boolean;
};

type ConfirmFetchFormProps = {
  /** 页面自己的 useFetcher()；提交仍走 fetcher，反馈分桶不受影响。 */
  fetcher: FetcherWithComponents<unknown>;
  confirm: ConfirmRequest;
  /** 隐藏字段 + 触发按钮（type="submit"），与普通 fetcher.Form 用法一致。 */
  children: ReactNode;
};

export function ConfirmFetchForm({
  fetcher,
  confirm,
  children,
}: ConfirmFetchFormProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // 拦截到的表单元素：确认时对它 requestSubmit()，绕开拦截一次性放行。
  const formRef = useRef<HTMLFormElement | null>(null);
  const bypassRef = useRef(false);
  const headingId = useId();

  return (
    <>
      <fetcher.Form
        method="post"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          if (bypassRef.current) {
            bypassRef.current = false;
            return;
          }
          event.preventDefault();
          formRef.current = event.currentTarget;
          dialogRef.current?.showModal();
        }}
      >
        {children}
      </fetcher.Form>
      <dialog
        ref={dialogRef}
        className="confirmDialog"
        aria-labelledby={headingId}
      >
        <div className="confirmDialogBody">
          <strong id={headingId}>{confirm.heading}</strong>
          <p>{confirm.body}</p>
        </div>
        <div className="confirmDialogActions">
          <s-button variant="tertiary" onClick={() => dialogRef.current?.close()}>
            {confirm.cancelLabel ?? "Cancel"}
          </s-button>
          <s-button
            variant="primary"
            tone={confirm.danger ? "critical" : "auto"}
            onClick={() => {
              dialogRef.current?.close();
              bypassRef.current = true;
              formRef.current?.requestSubmit();
            }}
          >
            {confirm.confirmLabel}
          </s-button>
        </div>
      </dialog>
    </>
  );
}
