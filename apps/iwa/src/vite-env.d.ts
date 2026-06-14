/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PORTMAP_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
