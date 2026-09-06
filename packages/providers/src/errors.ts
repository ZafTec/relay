import type { AzureProviderId } from "./types.ts";

export type AzureProviderErrorClassification =
  | "invalid_input"
  | "client_error"
  | "authentication"
  | "authorization"
  | "unprocessable_entity"
  | "rate_limit"
  | "server_error"
  | "network_error"
  | "aborted"
  | "timeout"
  | "response_too_large"
  | "invalid_response";

interface AzureProviderErrorDetails {
  readonly provider: AzureProviderId;
  readonly classification: AzureProviderErrorClassification;
  readonly retryable?: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly field?: string;
}

const MESSAGES: Readonly<Record<AzureProviderErrorClassification, string>> = {
  invalid_input: "Provider request is invalid",
  client_error: "Azure rejected the provider request",
  authentication: "Azure provider authentication failed",
  authorization: "Azure provider authorization failed",
  unprocessable_entity: "Azure could not process the provider request",
  rate_limit: "Azure provider rate limit exceeded",
  server_error: "Azure provider service failed",
  network_error: "Azure provider network request failed",
  aborted: "Azure provider request was aborted",
  timeout: "Azure provider request timed out",
  response_too_large: "Azure provider response exceeded a configured limit",
  invalid_response: "Azure provider returned an invalid response",
};

export class AzureProviderError extends Error {
  override readonly name = "AzureProviderError";
  readonly provider: AzureProviderId;
  readonly classification: AzureProviderErrorClassification;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly field?: string;

  constructor(details: AzureProviderErrorDetails) {
    const suffix = details.field === undefined ? "" : ` (${details.field})`;
    super(`${MESSAGES[details.classification]}${suffix}`);
    this.provider = details.provider;
    this.classification = details.classification;
    this.retryable = details.retryable ?? false;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.field = details.field;
  }

  toJSON(): Record<string, boolean | number | string> {
    const value: Record<string, boolean | number | string> = {
      name: this.name,
      message: this.message,
      provider: this.provider,
      classification: this.classification,
      retryable: this.retryable,
    };
    if (this.status !== undefined) value.status = this.status;
    if (this.retryAfterMs !== undefined) {
      value.retryAfterMs = this.retryAfterMs;
    }
    if (this.field !== undefined) value.field = this.field;
    return value;
  }
}

export function invalidInput(
  provider: AzureProviderId,
  field: string,
): AzureProviderError {
  return new AzureProviderError({
    provider,
    classification: "invalid_input",
    field,
  });
}

export function invalidResponse(
  provider: AzureProviderId,
  field?: string,
): AzureProviderError {
  return new AzureProviderError({
    provider,
    classification: "invalid_response",
    field,
  });
}

export function responseTooLarge(
  provider: AzureProviderId,
  field?: string,
): AzureProviderError {
  return new AzureProviderError({
    provider,
    classification: "response_too_large",
    field,
  });
}
