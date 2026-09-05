import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/** Dependencies shared by HTTP route handlers.
 *
 * Keeping these values in one object makes the eventual route extraction explicit and avoids
 * route modules reaching into bootstrap-level globals.
 */
export type ServerContext = {
  database: DatabaseSync;
  projectRoot: string;
  uiRoot: string;
};

export const createServerContext = (
  database: DatabaseSync,
  projectRoot: string,
): ServerContext => ({
  database,
  projectRoot,
  uiRoot: path.join(projectRoot, 'dist-ui'),
});
