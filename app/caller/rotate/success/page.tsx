import { CredentialOperationSuccessPage } from "../../credential-pages";

export const dynamic = "force-dynamic";

export default async function CallerRotateSuccessPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationSuccessPage
      operation="rotate"
      searchParams={searchParams}
    />
  );
}
