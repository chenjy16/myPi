import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

/** 非嵌入落地页：已带 shop 参数则进 /app，否则显示填店名登录表单。 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
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
