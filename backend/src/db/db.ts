import pg from 'pg';

/**
 * Acesso mínimo ao banco. Em produção usa o PostgreSQL (pg); nos testes,
 * o mesmo SQL roda no PGlite em memória (veja test/ajudantes.ts).
 */
export interface Db {
  /** Uma instrução, com parâmetros $1, $2… */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Várias instruções sem parâmetros (usado nas migrações). */
  exec(sql: string): Promise<void>;
  transacao<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  fechar(): Promise<void>;
}

type Executor = Pick<pg.Pool, 'query'> | pg.PoolClient;

function operacoes(alvo: Executor): Pick<Db, 'query' | 'exec'> {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const r = await alvo.query(sql, params);
      return r.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await alvo.query(sql);
    },
  };
}

export function criarDbPostgres(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  return {
    ...operacoes(pool),
    async transacao<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        const tx: Db = {
          ...operacoes(cliente),
          transacao: (f) => f(tx),
          fechar: async () => {},
        };
        const resultado = await fn(tx);
        await cliente.query('COMMIT');
        return resultado;
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    },
    fechar: () => pool.end(),
  };
}
