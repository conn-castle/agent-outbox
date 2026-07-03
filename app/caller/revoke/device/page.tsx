import { CredentialOperationDevicePage } from "../../credential-pages";
import {
  approveRevokeDevice,
  denyRevokeDevice,
  previewRevokeDevice
} from "../../credential-actions";

export const dynamic = "force-dynamic";

export default async function CallerRevokeDevicePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationDevicePage
      operation="revoke"
      searchParams={searchParams}
      previewAction={previewRevokeDevice}
      approveAction={approveRevokeDevice}
      denyAction={denyRevokeDevice}
    />
  );
}
