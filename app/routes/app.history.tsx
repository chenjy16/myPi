import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { PRODUCT_COPY_ENABLED } from "../features";
import { FeatureDisabledPage } from "../components/feature-disabled";
import { authenticate } from "../shopify.server";
import { safeLoader } from "../lib/route-error";
import db from "../db.server";

const STATUS_LABELS: Record<string, string> = {
  generating: "Generating",
  pending: "Pending confirmation",
  applying: "Writing back",
  applied: "Completed",
  failed: "Generation failed",
  conflicted: "Content conflict",
};

/** 本店最近 100 条文案任务；功能开关关闭渲染显式停用页。 */
export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!PRODUCT_COPY_ENABLED) {
    return { disabled: true as const, tasks: [] };
  }
  const tasks = await db.productDraft.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      productTitle: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return { disabled: false as const, tasks };
});

function formatTaskDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** 文案历史列表，点击任务进入 /app/copy?draftId=；开关关闭显示停用页。 */
export default function HistoryPage() {
  const data = useLoaderData<typeof loader>();

  if (data.disabled) {
    return <FeatureDisabledPage heading="History" featureName="Copy history" />;
  }

  const { tasks } = data;

  return (
    <s-page heading="History">
      <div className="workspace secondaryWorkspace">
        <div className="pageIntro">
          <span className="eyebrow">Task center</span>
          <h1>History</h1>
          <p>
            View recently generated product copy drafts and their processing
            status.
          </p>
        </div>
        {tasks.length === 0 ? (
          <div className="emptyTasks historyEmpty">
            <span className="emptyTaskIcon" aria-hidden="true">
              ◷
            </span>
            <strong>No history tasks yet</strong>
            <span>
              Generated copy tasks are saved here so you can review them later.
            </span>
            <Link to="/app/copy">Start generating copy</Link>
          </div>
        ) : (
          <div className="recentSection historyTable">
            <div className="sectionHeading">
              <div>
                <span className="sectionGlyph" aria-hidden="true">
                  ◷
                </span>
                <h2>Last 100 tasks</h2>
              </div>
              <span className="historyCount">{tasks.length} items</span>
            </div>
            <div className="taskTableWrap">
              <table className="taskTable">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Task type</th>
                    <th>Created</th>
                    <th>Last updated</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task.id}>
                      <td className="taskProduct">{task.productTitle}</td>
                      <td>
                        <span className="taskType">
                          <span aria-hidden="true">✦</span> Copy generation
                        </span>
                      </td>
                      <td>{formatTaskDate(task.createdAt)}</td>
                      <td>{formatTaskDate(task.updatedAt)}</td>
                      <td>
                        <span className={`taskStatus status-${task.status}`}>
                          {STATUS_LABELS[task.status] ?? task.status}
                        </span>
                      </td>
                      <td>
                        <Link
                          className="secondaryButton"
                          to={`/app/copy?draftId=${encodeURIComponent(task.id)}`}
                        >
                          View result
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
