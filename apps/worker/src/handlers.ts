import {
  type CatalogRoutingDecision,
  createHandlerRegistry,
  type HandlerRegistry,
  validateRoutingDecisionForRun,
} from "@relay/catalog";
import type { DatabasePool } from "@relay/database";
import type {
  ExecutionHandler,
  ExecutionHandlerContext,
  ExecutionHandlerResult,
} from "@relay/queue";

export interface RegisteredExecutionHandler {
  readonly key: string;
  readonly inputSchemaVersion: number;
  readonly handlerVersion: string;
  readonly execute: (
    context: ExecutionHandlerContext & {
      readonly routingDecision: CatalogRoutingDecision;
    },
  ) => Promise<ExecutionHandlerResult>;
}

export interface ExecutionHandlerRegistry {
  readonly catalogHandlers: HandlerRegistry;
  register(handler: RegisteredExecutionHandler): void;
  unregister(key: string): boolean;
  get(key: string): RegisteredExecutionHandler | undefined;
  readonly keys: ReadonlySet<string>;
}

export function createExecutionHandlerRegistry(
  initialHandlers: readonly RegisteredExecutionHandler[] = [],
): ExecutionHandlerRegistry {
  const catalogHandlers = createHandlerRegistry();
  const handlers = new Map<string, RegisteredExecutionHandler>();

  const register = (handler: RegisteredExecutionHandler): void => {
    if (typeof handler.execute !== "function") {
      throw new TypeError("execution handler must provide execute()");
    }
    catalogHandlers.register({
      key: handler.key,
      inputSchemaVersion: handler.inputSchemaVersion,
      handlerVersion: handler.handlerVersion,
    });
    handlers.set(handler.key, Object.freeze({ ...handler }));
  };
  for (const handler of initialHandlers) register(handler);

  return {
    catalogHandlers,
    register,
    unregister(key: string): boolean {
      catalogHandlers.unregister(key);
      return handlers.delete(key);
    },
    get(key: string): RegisteredExecutionHandler | undefined {
      return handlers.get(key);
    },
    get keys(): ReadonlySet<string> {
      return new Set(handlers.keys());
    },
  };
}

export function createRegistryBackedExecutionHandler(
  pool: DatabasePool,
  registry: ExecutionHandlerRegistry,
): ExecutionHandler {
  return async (context) => {
    const validation = await validateRoutingDecisionForRun(
      pool,
      registry.catalogHandlers,
      context.job.runId,
    );
    if (validation.kind === "unavailable") {
      return {
        kind: "failed",
        retryClassification: "schema_or_policy_failure",
        error: `Execution route unavailable: ${
          validation.issues.map((issue) => issue.code).join(",")
        }`,
      };
    }

    const handler = registry.get(validation.value.route.handlerKey);
    if (handler === undefined) {
      return {
        kind: "failed",
        retryClassification: "schema_or_policy_failure",
        error:
          `Execution handler not registered: ${validation.value.route.handlerKey}`,
      };
    }

    return await handler.execute({
      ...context,
      routingDecision: validation.value,
    });
  };
}
