import rawSystemContract from "../../system-contract.json" with { type: "json" };

import { validateSystemContract } from "./system-contract-validation.mjs";

export type { SystemContract } from "./system-contract-validation.mjs";
export { validateSystemContract };

export const SYSTEM_CONTRACT = validateSystemContract(rawSystemContract);
