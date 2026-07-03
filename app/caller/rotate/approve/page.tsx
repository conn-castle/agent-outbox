import { CredentialOperationApprovePage } from "../../credential-pages";
import {
  approveRotateBrowser,
  denyRotateBrowser
} from "../../credential-actions";

export const dynamic = "force-dynamic";

export default async function CallerRotateApprovePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationApprovePage
      operation="rotate"
      searchParams={searchParams}
      approveAction={approveRotateBrowser}
      denyAction={denyRotateBrowser}
    />
  );
}
