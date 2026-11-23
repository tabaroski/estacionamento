import type { Db } from './db.js';
import { migracoes } from './migracoes.js';

/** Aplica as migrações que faltam, cada uma na sua transação. Retorna as aplicadas. */
export async function migrar(db: Db): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS migracoes_aplicadas (
      id text PRIMARY KEY,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )
  `);
  const feitas = new Set(
    (await db.query<{ id: string }>('SELECT id FROM migracoes_aplicadas')).map((m) => m.id),
  );
  const aplicadas: string[] = [];
  for (const m of migracoes) {
    if (feitas.has(m.id)) continue;
    await db.transacao(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO migracoes_aplicadas (id) VALUES ($1)', [m.id]);
    });
    aplicadas.push(m.id);
  }
  return aplicadas;
}

/** Garante que o portão configurado existe no banco. */
export async function garantirPortao(db: Db, portao: { id: string; nome: string }): Promise<void> {
  await db.query(
    `INSERT INTO portoes (id, nome) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET nome = EXCLUDED.nome`,
    [portao.id, portao.nome],
  );
}
