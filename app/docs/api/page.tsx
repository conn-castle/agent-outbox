import type { Metadata } from "next";

import { ApiDocsPage } from "../../../src/components/docs/ApiDocsPage";
import { API_DOCS_INDEX_SLUG } from "../../../src/shared/api-docs-manifest";

export const metadata: Metadata = {
  title: "API Documentation | Agent Outbox",
  description:
    "Connect an agent, send a human review request, and retrieve the decision asynchronously."
};

export default function ApiQuickStartPage() {
  return <ApiDocsPage slug={API_DOCS_INDEX_SLUG} />;
}
