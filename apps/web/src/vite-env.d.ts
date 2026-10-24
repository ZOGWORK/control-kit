interface ImportMetaEnv {
  readonly VITE_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Arc components style themselves with CSS modules; Vite resolves these to a map of class names. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
