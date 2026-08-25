import { type ContractParser, stringValue } from "./schema.ts";

export const PUBLIC_ID_PATTERNS: Readonly<{
  tool: RegExp;
  toolVersion: RegExp;
  run: RegExp;
  artifact: RegExp;
  artifactVersion: RegExp;
  artifactUpload: RegExp;
  outputSet: RegExp;
  shareLink: RegExp;
  usageReservation: RegExp;
}> = Object.freeze({
  tool: /^tool_[0-9a-f]{32}$/,
  toolVersion: /^tver_[0-9a-f]{32}$/,
  run: /^run_[0-9a-f]{32}$/,
  artifact: /^art_[0-9a-f]{32}$/,
  artifactVersion: /^aver_[0-9a-f]{32}$/,
  artifactUpload: /^upl_[0-9a-f]{32}$/,
  outputSet: /^outset_[0-9a-f]{32}$/,
  shareLink: /^share_[0-9a-f]{32}$/,
  usageReservation: /^reservation_[0-9a-f]{32}$/,
});

export type PublicIdKind = keyof typeof PUBLIC_ID_PATTERNS;

export function publicId(
  value: unknown,
  path: string,
  kind: PublicIdKind,
): string {
  return stringValue(value, path, {
    minLength: 36,
    maxLength: 44,
    pattern: PUBLIC_ID_PATTERNS[kind],
  });
}

export const toolIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "tool");
export const toolVersionIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "toolVersion");
export const runIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "run");
export const artifactIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "artifact");
export const artifactVersionIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "artifactVersion");
export const artifactUploadIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "artifactUpload");
export const outputSetIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "outputSet");
export const shareLinkIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "shareLink");
export const usageReservationIdParser: ContractParser<string> = (value, path) =>
  publicId(value, path, "usageReservation");

export const TOOL_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export const DECIMAL_AMOUNT_PATTERN =
  /^(?:0|[1-9][0-9]{0,28})(?:\.[0-9]{1,9})?$/;

export const toolKeyParser: ContractParser<string> = (value, path) =>
  stringValue(value, path, {
    minLength: 1,
    maxLength: 128,
    pattern: TOOL_KEY_PATTERN,
  });

export const safeCodeParser: ContractParser<string> = (value, path) =>
  stringValue(value, path, {
    minLength: 1,
    maxLength: 128,
    pattern: SAFE_CODE_PATTERN,
  });

export const decimalAmountParser: ContractParser<string> = (value, path) =>
  stringValue(value, path, {
    minLength: 1,
    maxLength: 39,
    pattern: DECIMAL_AMOUNT_PATTERN,
  });
