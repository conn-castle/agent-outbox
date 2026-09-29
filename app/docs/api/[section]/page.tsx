import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ApiDocsPage } from "../../../../src/components/docs/ApiDocsPage";
import {
  apiDocBySlug,
  apiDocNavigation,
  isApiDocSlug
} from "../../../../src/server/api-docs";
import { API_DOCS_INDEX_SLUG } from "../../../../src/shared/api-docs-manifest";

export const dynamicParams = false;

export function generateStaticParams() {
  return apiDocNavigation
    .filter((item) => item.slug !== API_DOCS_INDEX_SLUG)
    .map((item) => ({ section: item.slug }));
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const { section } = await params;
  if (!isApiDocSlug(section) || section === API_DOCS_INDEX_SLUG) return {};
  return {
    title: `${apiDocBySlug(section).title} | Agent Outbox`,
    description: `Canonical Agent Outbox ${apiDocBySlug(section).title.toLowerCase()}.`
  };
}

export default async function ApiReferencePage({
  params
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isApiDocSlug(section) || section === API_DOCS_INDEX_SLUG) notFound();
  return <ApiDocsPage slug={section} />;
}
