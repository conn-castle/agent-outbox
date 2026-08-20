import type { Metadata } from "next";

import { ApiDocsPage } from "../../../src/components/docs/ApiDocsPage";

export const metadata: Metadata = {
  title: "API Documentation | Agent Outbox",
  description:
    "Connect an agent, send a human review request, and retrieve the decision asynchronously."
};

export default function ApiQuickStartPage() {
  return <ApiDocsPage slug="quickstart" />;
}
