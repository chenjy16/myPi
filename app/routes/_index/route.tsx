import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

/**
 * 非嵌入落地页 / 首次安装入口。
 * - 嵌入请求（带 embedded=1，已安装）：沿用模板行为，进 /app 走 token-exchange 会话。
 * - 顶层带 shop（未安装首次入口，如审核从应用页直接打开）：转 /auth/login，
 *   由官方 login() 跳到 Shopify 原生 /admin/oauth/install 触发授权页。
 *   直接进 /app 会在没会话时强起 OAuth，旧 redirect_urls 对不上就会落 admin 404。
 * - 无 shop：显示手动输入店名的登录表单。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    if (url.searchParams.get("embedded")) {
      throw redirect(`/app?${url.searchParams.toString()}`);
    }
    throw redirect(`/auth/login?shop=${encodeURIComponent(shop)}`);
  }

  return { showForm: Boolean(login) };
};

/** 开发时手动输入 .myshopify.com 域名并提交到 /auth/login。 */
export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <div className={styles.brand}>
          <img className={styles.logo} src="/pi-logo.png" alt="mypi" />
          <span>mypi</span>
        </div>
        <div>
          <p className={styles.eyebrow}>Inventory Decision Intelligence</p>
          <h1 className={styles.heading}>
            Reorder with confidence, not guesswork
          </h1>
          <p className={styles.text}>
            mypi turns your Shopify sales, stock and supplier constraints into
            transparent, verifiable replenishment advice, so you buy the right
            quantity from the right supplier at the right time.
          </p>
        </div>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shopify store domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-shop.myshopify.com"
                autoComplete="on"
                required
              />
              <span>
                Enter the .myshopify.com domain of your development store
              </span>
            </label>
            <button className={styles.button} type="submit">
              Log in to your Shopify store
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Demand you can trust</strong>: corrects for stockouts and
            keeps observed sales separate from estimated demand.
          </li>
          <li>
            <strong>Supplier-aware buying</strong>: applies MOQ, case pack and
            full lead times so advice is actually executable.
          </li>
          <li>
            <strong>Explainable by design</strong>: every recommendation shows
            its inputs and stays deterministic, so you keep control.
          </li>
        </ul>
      </div>
    </div>
  );
}
