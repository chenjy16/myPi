import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { safeLoader } from "../lib/route-error";

export const loader = safeLoader(async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
});

export default function SupplyChainPage() {
  return (
    <div className="ds">
      <div className="dsPanel dsPlaceholder">
        <span aria-hidden="true">⛓</span>
        <h1>Supply Chain</h1>
        <p>
          Configure segmented lead times across production, freight, customs and
          receiving, plus supplier shutdown calendars. This module is coming
          soon.
        </p>
        <Link to="/app">← Back to home</Link>
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
