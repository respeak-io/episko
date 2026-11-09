/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `preview` in a build of the preview branch (.github/workflows/preview.yml). */
  readonly VITE_EPISKO_CHANNEL?: string;
}
