import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from '../src/db/db.js';
import { migrar } from '../src/db/migrar.js';

type Alvo = Pick<PGlite, 'query' | 'exec'> | Transaction;

function operacoes(alvo: Alvo): Pick<Db, 'query' | 'exec'> {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const r = await alvo.query<T>(sql, params);
      return r.rows;
    },
    async exec(sql: string): Promise<void> {
      await alvo.exec(sql);
    },
  };
}

/** PostgreSQL de verdade (compilado para WebAssembly), em memória, já migrado. */
export async function criarDbMemoria(): Promise<Db> {
  const pglite = await PGlite.create();
  const db: Db = {
    ...operacoes(pglite),
    transacao: <T>(fn: (tx: Db) => Promise<T>) =>
      pglite.transaction(async (t) => {
        const tx: Db = { ...operacoes(t), transacao: (f) => f(tx), fechar: async () => {} };
        return fn(tx);
      }),
    fechar: () => pglite.close(),
  };
  await migrar(db);
  return db;
}
