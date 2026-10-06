export declare function cloudflareOptions(env: { command: "serve" | "build"; isPreview?: boolean }): {
  remoteBindings?: false;
  config?: { vars: { READ_ONLY: string } };
};
