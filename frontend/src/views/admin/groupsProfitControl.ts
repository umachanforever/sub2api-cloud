// Group profit-control form helpers: percentage <-> decimal conversion and pre-submission validation.
// The backend stores decimal(10,4) values (0.30 = 30%), while the UI accepts and displays percentages;
// fix precision at 4 decimal places to avoid displaying floating-point artifacts such as 0.3 * 100 = 30.000000000000004.

export const profitPercentToDecimal = (
  value: number | string | null | undefined,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed * 100) / 10000;
};

export const profitDecimalToPercent = (
  value: number | null | undefined,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed * 1e6) / 1e4;
};

export type ProfitControlFormState = {
  platform: string;
  profit_control_enabled: boolean;
  profit_min_margin_percent: number | string | null;
  profit_safety_buffer_percent: number | string | null;
};

export const isProfitControlPlatform = (platform: string): boolean =>
  ["openai", "anthropic", "gemini", "grok", "antigravity"].includes(platform);

// Pre-submission validation: margin and buffer must each be in [0,1), and their sum must be < 1 (otherwise the threshold is <= 0,
// excluding every account with calculable pricing). Return null on success; otherwise return the error message's i18n key
// (relative to the admin.groups.profitControl prefix). Validate only for supported platforms when the toggle is enabled.
//
// Upper-bound validation must use the result of profitPercentToDecimal rather than the UI percentage:
// backend validProfitControlRatio validates the decimal range [0,1), while 99.999% rounds
// up to 1.0—checking `< 100` as a percentage would let the frontend accept it, followed by a backend 400.
export const validateProfitControlFormState = (
  form: ProfitControlFormState,
): string | null => {
  if (!isProfitControlPlatform(form.platform) || !form.profit_control_enabled) {
    return null;
  }
  const marginPercent = Number(form.profit_min_margin_percent || 0);
  const bufferPercent = Number(form.profit_safety_buffer_percent || 0);
  if (!Number.isFinite(marginPercent) || marginPercent < 0) {
    return "marginRangeError";
  }
  if (!Number.isFinite(bufferPercent) || bufferPercent < 0) {
    return "bufferRangeError";
  }
  // Validate the decimal value actually submitted to the backend, with boundaries aligned to its construction.
  const margin = profitPercentToDecimal(marginPercent);
  const buffer = profitPercentToDecimal(bufferPercent);
  if (margin >= 1) {
    return "marginRangeError";
  }
  if (buffer >= 1) {
    return "bufferRangeError";
  }
  if (margin + buffer >= 1) {
    return "sumTooHigh";
  }
  return null;
};
