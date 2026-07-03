import { CredentialOperationDevicePage } from "../../credential-pages";
import {
  approveRotateDevice,
  denyRotateDevice,
  previewRotateDevice
} from "../../credential-actions";

export const dynamic = "force-dynamic";

export default async function CallerRotateDevicePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <CredentialOperationDevicePage
      operation="rotate"
      searchParams={searchParams}
      previewAction={previewRotateDevice}
      approveAction={approveRotateDevice}
      denyAction={denyRotateDevice}
    />
  );
}
