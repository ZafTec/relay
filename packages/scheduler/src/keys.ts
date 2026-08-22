function prefix(env: string): string {
  return `relay:${env}:{capacity}:scheduler`;
}

export interface SchedulerRedisKeys {
  readonly base: string;
  readonly jobs: string;
  readonly due: string;
  readonly dispatch: string;
  readonly dispatchMetadata: string;
  readonly profiles: string;
  readonly state: string;
}

export function schedulerKeys(env: string): SchedulerRedisKeys {
  const base = prefix(env);
  return {
    base,
    jobs: `${base}:jobs`,
    due: `${base}:due`,
    dispatch: `${base}:dispatch`,
    dispatchMetadata: `${base}:dispatch:metadata`,
    profiles: `${base}:profiles`,
    state: `${base}:state`,
  };
}
