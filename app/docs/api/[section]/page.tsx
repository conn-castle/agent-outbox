import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ApiDocsPage } from "../../../../src/components/docs/ApiDocsPage";
import {
  apiDocBySlug,
  apiDocNavigation,
  isApiDocSlug
} from "../../../../src/server/api-docs";

export const dynamicParams = false;

export function generateStaticParams() {
  return apiDocNavigation
    .filter((item) => item.slug !== "quickstart")
    .map((item) => ({ section: item.slug }));
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ section: string }>;
}): Promise<Metadata> {
  const { section } = await params;
  if (!isApiDocSlug(section) || section === "quickstart") return {};
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
  if (!isApiDocSlug(section) || section === "quickstart") notFound();
  return <ApiDocsPage slug={section} />;
}
