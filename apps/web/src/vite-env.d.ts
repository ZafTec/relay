/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BETTER_AUTH_URL?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_APP_ORIGIN?: string;
  readonly VITE_FARO_COLLECTOR_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
