import type { Hub } from "./hub";

export interface Env {
  readonly DB: D1Database;
  readonly HUB: DurableObjectNamespace<Hub>;
  readonly CF_VERSION_METADATA: WorkerVersionMetadata;
  readonly CONTENT: R2Bucket;
  /**
   * Only set in `.dev.vars`, never in a deployment. A passkey ceremony needs a real browser and a real
   * authenticator, so without an escape hatch the service would be untestable locally — and weakening
   * the real auth path to make tests pass is how the real auth path stops being real.
   */
  readonly DEV_TOKEN?: string;
}
