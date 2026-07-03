import { CredentialOperationErrorPage } from "../../credential-pages";

export const dynamic = "force-dynamic";

export default async function CallerRevokeErrorPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationErrorPage
      operation="revoke"
      searchParams={searchParams}
    />
  );
}
