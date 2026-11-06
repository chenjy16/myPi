import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { PRODUCT_COPY_ENABLED } from "../features";
import { FeatureDisabledPage } from "../components/feature-disabled";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { adminGraphql } from "../lib/admin-graphql.server";
import { AppError, SHOPIFY_API_UNAVAILABLE_MESSAGE } from "../lib/app-error";
import { createLogger } from "../lib/logger";
import { safeLoader } from "../lib/route-error";
import { generateProductCopy } from "../pi.server";
import { ProductCopyError } from "../product-copy.server";

type Product = {
  id: string;
  title: string;
  descriptionHtml: string;
};

const logger = createLogger({ component: "route.copy" });

const PRODUCT_QUERY = `#graphql
  query ProductCopyProducts {
    products(first: 50, sortKey: TITLE) {
      nodes {
        id
        title
        descriptionHtml
      }
    }
  }`;

const PRODUCT_BY_ID_QUERY = `#graphql
  query ProductCopyProduct($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
    }
  }`;

const UPDATE_PRODUCT_MUTATION = `#graphql
  mutation ApplyProductCopy($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        descriptionHtml
      }
      userErrors {
        field
        message
      }
    }
  }`;

/** 当前授权是否包含写商品（Apply 唯一需要的写权限）。 */
function hasWriteProductsScope(scope: string | undefined): boolean {
  return (
    scope
      ?.split(",")
      .map((item) => item.trim())
      .includes("write_products") ?? false
  );
}

/** 校验 Shopify Product GID。 */
function isProductId(value: FormDataEntryValue | null): value is string {
  return (
    typeof value === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(value)
  );
}

/** 校验生成请求的 UUID，用于店铺内幂等。 */
function isRequestId(value: FormDataEntryValue | null): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

/** 识别 Prisma 唯一约束冲突（同一 shop+requestId 重复提交）。 */
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/** 文案页数据：开关关闭渲染显式停用页；否则拉前 50 个商品和可选草稿。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!PRODUCT_COPY_ENABLED) {
    return {
      disabled: true as const,
      products: [] as Product[],
      shop: session.shop,
      draft: null,
      requestId: "",
    };
  }
  const result = await adminGraphql<{ products: { nodes: Product[] } }>(
    admin,
    PRODUCT_QUERY,
  );
  const draftId = new URL(request.url).searchParams.get("draftId");
  const draft = draftId
    ? await db.productDraft.findFirst({
        where: { id: draftId, shop: session.shop },
      })
    : null;

  return {
    disabled: false as const,
    products: result.products.nodes,
    shop: session.shop,
    draft,
    requestId: crypto.randomUUID(),
  };
});

/**
 * generate：重读商品 → 隔离 Pi session 出草稿（pending）。
 * apply：CAS 抢占草稿 → 冲突检查 → 商家确认后 productUpdate。
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!PRODUCT_COPY_ENABLED) {
    return {
      error: "Product copy is not available in the current mypi release.",
      nextRequestId: "",
    };
  }
  const formData = await request.formData();
  const intent = formData.get("intent");

  const nextRequestId = crypto.randomUUID();
  try {
    if (intent === "generate") {
      const productId = formData.get("productId");
      const requestId = formData.get("requestId");
      if (!isProductId(productId)) {
        return { error: "Please select a valid product.", nextRequestId };
      }
      if (!isRequestId(requestId)) {
        return {
          error:
            "The generate request is invalid. Please refresh and try again.",
          nextRequestId,
        };
      }

      const result = await adminGraphql<{ product: Product | null }>(
        admin,
        PRODUCT_BY_ID_QUERY,
        { variables: { id: productId } },
      );
      if (!result.product) {
        return {
          error: "Product not found. Please refresh and try again.",
          nextRequestId,
        };
      }

      let draft = await db.productDraft.findUnique({
        where: { shop_requestId: { shop: session.shop, requestId } },
      });
      if (draft) {
        if (draft.status === "generating") {
          return { error: "This request is generating copy. Please wait." };
        }
        if (draft.status === "pending" || draft.status === "applied") {
          return { draft, nextRequestId };
        }
        return {
          error:
            "This generation request has finished. Please submit again to create a new draft.",
          nextRequestId,
        };
      }

      try {
        draft = await db.productDraft.create({
          data: {
            shop: session.shop,
            requestId,
            productId: result.product.id,
            productTitle: result.product.title,
            originalTitle: result.product.title,
            originalDescriptionHtml: result.product.descriptionHtml,
            suggestedTitle: "",
            suggestedDescription: "",
            status: "generating",
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;

        const duplicate = await db.productDraft.findUnique({
          where: { shop_requestId: { shop: session.shop, requestId } },
        });
        if (duplicate?.status === "generating") {
          return { error: "This request is generating copy. Please wait." };
        }
        if (duplicate) return { draft: duplicate, nextRequestId };
        throw error;
      }

      try {
        const suggestion = await generateProductCopy(result.product);
        const completedDraft = await db.productDraft.update({
          where: { id: draft.id },
          data: {
            suggestedTitle: suggestion.title,
            suggestedDescription: suggestion.description,
            status: "pending",
          },
        });
        return { draft: completedDraft, nextRequestId };
      } catch (error) {
        await db.productDraft.updateMany({
          where: { id: draft.id, status: "generating" },
          data: { status: "failed" },
        });
        throw error;
      }
    }

    if (intent === "apply") {
      const draftId = formData.get("draftId");
      if (typeof draftId !== "string" || !draftId) {
        return { error: "The draft is invalid. Please regenerate." };
      }

      const draft = await db.productDraft.findFirst({
        where: { id: draftId, shop: session.shop },
      });
      if (!draft) {
        return { error: "The draft doesn't exist. Please regenerate." };
      }
      if (draft.status === "applied") {
        return { draft, applied: true };
      }
      if (draft.status !== "pending") {
        return {
          error:
            "The draft is being processed or has expired. Please regenerate.",
        };
      }

      const claim = await db.productDraft.updateMany({
        where: { id: draft.id, shop: session.shop, status: "pending" },
        data: { status: "applying" },
      });
      if (claim.count !== 1) {
        const latestDraft = await db.productDraft.findFirst({
          where: { id: draft.id, shop: session.shop },
        });
        if (latestDraft?.status === "applied") {
          return { draft: latestDraft, applied: true };
        }
        return { error: "The draft is being processed. Please wait." };
      }

      try {
        const current = await adminGraphql<{ product: Product | null }>(
          admin,
          PRODUCT_BY_ID_QUERY,
          { variables: { id: draft.productId } },
        );
        const descriptionHtml = toDescriptionHtml(draft.suggestedDescription);
        if (
          current.product?.title === draft.suggestedTitle &&
          current.product.descriptionHtml === descriptionHtml
        ) {
          const appliedDraft = await db.productDraft.update({
            where: { id: draft.id },
            data: { status: "applied", appliedAt: new Date() },
          });
          return { draft: appliedDraft, applied: true };
        }
        if (
          !current.product ||
          current.product.title !== draft.originalTitle ||
          current.product.descriptionHtml !== draft.originalDescriptionHtml
        ) {
          const conflictedDraft = await db.productDraft.update({
            where: { id: draft.id },
            data: { status: "conflicted" },
          });
          return {
            draft: conflictedDraft,
            error:
              "The product changed after the draft was generated. Please regenerate the copy before confirming.",
          };
        }

        // Beta 的默认 scope 不含 write_products；缺权限时必须直接拒绝，而不是让 Shopify 报错。
        if (!hasWriteProductsScope(session.scope)) {
          const blockedDraft = await db.productDraft.update({
            where: { id: draft.id },
            data: { status: "pending" },
          });
          return {
            draft: blockedDraft,
            error:
              "Applying copy needs the write_products permission, which this installation doesn't have. Re-authorize the app with write_products enabled.",
          };
        }

        const update = await adminGraphql<{
          productUpdate: {
            product: Product | null;
            userErrors: Array<{ field: string[] | null; message: string }>;
          };
        }>(admin, UPDATE_PRODUCT_MUTATION, {
          variables: {
            product: {
              id: draft.productId,
              title: draft.suggestedTitle,
              descriptionHtml,
            },
          },
        });
        if (update.productUpdate.userErrors.length) {
          await db.productDraft.update({
            where: { id: draft.id },
            data: { status: "pending" },
          });
          return {
            error: update.productUpdate.userErrors
              .map(({ message }) => message)
              .join("; "),
          };
        }
        if (!update.productUpdate.product) {
          throw new AppError(
            "shopify_api",
            SHOPIFY_API_UNAVAILABLE_MESSAGE,
            "productUpdate returned no product",
          );
        }

        const appliedDraft = await db.productDraft.update({
          where: { id: draft.id },
          data: { status: "applied", appliedAt: new Date() },
        });
        return { draft: appliedDraft, applied: true };
      } catch (error) {
        await db.productDraft.updateMany({
          where: { id: draft.id, status: "applying" },
          data: { status: "pending" },
        });
        throw error;
      }
    }

    return { error: "Unsupported operation." };
  } catch (error) {
    logger.error("Product copy action failed", {
      code: error instanceof ProductCopyError ? error.code : "operation",
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      error:
        error instanceof ProductCopyError
          ? error.message
          : "Operation failed. Please check the app logs and try again.",
      ...(intent === "generate" ? { nextRequestId } : {}),
    };
  }
};

/** 把模型纯文本描述转成简单 HTML 段落，供 productUpdate 使用。 */
function toDescriptionHtml(description: string): string {
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(
      (line) =>
        `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`,
    )
    .join("");
}

/** 单商品文案：选择商品、生成预览、确认后写回 Shopify；开关关闭显示停用页。 */
export default function ProductCopyPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  if (data.disabled) {
    return (
      <FeatureDisabledPage
        heading="Copy generation"
        featureName="Product copy generation"
      />
    );
  }

  const { products, draft: initialDraft, requestId: initialRequestId } = data;
  const draft =
    fetcher.data && "draft" in fetcher.data ? fetcher.data.draft : initialDraft;
  const requestId =
    fetcher.data &&
    "nextRequestId" in fetcher.data &&
    typeof fetcher.data.nextRequestId === "string"
      ? fetcher.data.nextRequestId
      : initialRequestId;
  const isBusy = fetcher.state !== "idle";

  return (
    <s-page heading="Copy generation">
      <s-section heading="Generate a copy draft">
        <s-paragraph>
          After you select a product, Pi generates title and description
          suggestions. Content is only written back to Shopify after you
          confirm.
        </s-paragraph>
        {products.length === 0 ? (
          <s-paragraph>This store has no products available.</s-paragraph>
        ) : (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="generate" />
            <input type="hidden" name="requestId" value={requestId} />
            <s-stack direction="block" gap="base">
              <s-select label="Select a product" name="productId" required>
                {products.map((product) => (
                  <s-option key={product.id} value={product.id}>
                    {product.title}
                  </s-option>
                ))}
              </s-select>
              <s-button
                type="submit"
                variant="primary"
                {...(isBusy ? { loading: true } : {})}
                disabled={isBusy}
              >
                Generate copy
              </s-button>
            </s-stack>
          </fetcher.Form>
        )}
      </s-section>

      {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
        <s-section heading="Operation not completed">
          <s-paragraph>{fetcher.data.error}</s-paragraph>
        </s-section>
      )}

      {draft && (
        <s-section heading="Copy preview">
          <s-stack direction="block" gap="base">
            <s-text>Product: {draft.productTitle}</s-text>
            <s-heading>Original title</s-heading>
            <s-paragraph>{draft.originalTitle}</s-paragraph>
            <s-heading>Original description</s-heading>
            <s-paragraph>{draft.originalDescriptionHtml}</s-paragraph>
            <s-heading>Suggested title</s-heading>
            <s-paragraph>{draft.suggestedTitle}</s-paragraph>
            <s-heading>Suggested description</s-heading>
            <s-paragraph>{draft.suggestedDescription}</s-paragraph>
            {draft.status === "pending" ? (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="apply" />
                <input type="hidden" name="draftId" value={draft.id} />
                <s-button
                  type="submit"
                  variant="primary"
                  {...(isBusy ? { loading: true } : {})}
                  disabled={isBusy}
                >
                  Confirm and write back to product
                </s-button>
              </fetcher.Form>
            ) : draft.status === "applied" ? (
              <s-paragraph>
                The copy was written back to Shopify successfully.
              </s-paragraph>
            ) : draft.status === "conflicted" ? (
              <s-paragraph>
                The product has changed. Please regenerate the copy before
                confirming.
              </s-paragraph>
            ) : draft.status === "applying" ? (
              <s-paragraph>Confirming the write-back, please wait.</s-paragraph>
            ) : (
              <s-paragraph>
                This draft cannot be written back right now. Please regenerate.
              </s-paragraph>
            )}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
