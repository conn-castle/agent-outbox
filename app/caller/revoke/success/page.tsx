import { CredentialOperationSuccessPage } from "../../credential-pages";

export const dynamic = "force-dynamic";

export default async function CallerRevokeSuccessPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationSuccessPage
      operation="revoke"
      searchParams={searchParams}
    />
  );
}
