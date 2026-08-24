import type pg from "pg";

export type ArtifactDatabasePool = InstanceType<typeof pg.Pool>;
export type ArtifactTransaction = pg.PoolClient;

export interface ArtifactQueryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export async function withArtifactTransaction<T>(
  pool: ArtifactDatabasePool,
  fn: (client: ArtifactTransaction) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}
