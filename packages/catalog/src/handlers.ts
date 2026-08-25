export const DEFAULT_INPUT_SCHEMA_VERSION = 1;
export const DEFAULT_HANDLER_VERSION = "1";

export interface HandlerCompatibility {
  readonly inputSchemaVersion: number;
  readonly handlerVersion: string;
}

export interface HandlerRegistration extends HandlerCompatibility {
  readonly key: string;
}

export type HandlerRegistrationInput = string | HandlerRegistration;

export interface HandlerRegistry {
  register(registration: HandlerRegistrationInput): void;
  unregister(key: string): boolean;
  has(key: string): boolean;
  get(key: string): HandlerRegistration | undefined;
  isCompatible(key: string, compatibility: HandlerCompatibility): boolean;
  readonly keys: ReadonlySet<string>;
}

function normalizeRegistration(
  registration: HandlerRegistrationInput,
): HandlerRegistration {
  const value = typeof registration === "string"
    ? {
      key: registration,
      inputSchemaVersion: DEFAULT_INPUT_SCHEMA_VERSION,
      handlerVersion: DEFAULT_HANDLER_VERSION,
    }
    : registration;

  if (value.key.trim() === "") {
    throw new TypeError("handler key must not be empty");
  }
  if (
    !Number.isSafeInteger(value.inputSchemaVersion) ||
    value.inputSchemaVersion <= 0
  ) {
    throw new TypeError(
      "handler inputSchemaVersion must be a positive integer",
    );
  }
  if (value.handlerVersion.trim() === "") {
    throw new TypeError("handler version must not be empty");
  }

  return Object.freeze({
    key: value.key,
    inputSchemaVersion: value.inputSchemaVersion,
    handlerVersion: value.handlerVersion,
  });
}

export function createHandlerRegistry(
  initialRegistrations: readonly HandlerRegistrationInput[] = [],
): HandlerRegistry {
  const registrations = new Map<string, HandlerRegistration>();
  for (const registration of initialRegistrations) {
    const normalized = normalizeRegistration(registration);
    registrations.set(normalized.key, normalized);
  }

  return {
    register(registration: HandlerRegistrationInput): void {
      const normalized = normalizeRegistration(registration);
      registrations.set(normalized.key, normalized);
    },
    unregister(key: string): boolean {
      return registrations.delete(key);
    },
    has(key: string): boolean {
      return registrations.has(key);
    },
    get(key: string): HandlerRegistration | undefined {
      return registrations.get(key);
    },
    isCompatible(
      key: string,
      compatibility: HandlerCompatibility,
    ): boolean {
      const registration = registrations.get(key);
      return registration !== undefined &&
        registration.inputSchemaVersion === compatibility.inputSchemaVersion &&
        registration.handlerVersion === compatibility.handlerVersion;
    },
    get keys(): ReadonlySet<string> {
      return new Set(registrations.keys());
    },
  };
}
