import { CredentialOperationErrorPage } from "../../credential-pages";

export const dynamic = "force-dynamic";

export default async function CallerRotateErrorPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationErrorPage
      operation="rotate"
      searchParams={searchParams}
    />
  );
}
