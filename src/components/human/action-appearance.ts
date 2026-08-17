import type { ActionStyle, ActionTone } from "../../server/input-schema.ts";

export function actionAppearanceClass(
  baseClass: string,
  action: { tone?: ActionTone | null; style?: ActionStyle | null }
) {
  return action.tone && action.style
    ? `${baseClass} action-has-appearance action-tone-${action.tone} action-style-${action.style}`
    : baseClass;
}
