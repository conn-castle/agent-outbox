import { CredentialOperationApprovePage } from "../../credential-pages";
import {
  approveRevokeBrowser,
  denyRevokeBrowser
} from "../../credential-actions";

export const dynamic = "force-dynamic";

export default async function CallerRevokeApprovePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationApprovePage
      operation="revoke"
      searchParams={searchParams}
      approveAction={approveRevokeBrowser}
      denyAction={denyRevokeBrowser}
    />
  );
}
