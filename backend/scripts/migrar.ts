/** Aplica as migrações pendentes. O servidor também faz isso ao iniciar. */
import { carregarConfig } from '../src/config.js';
import { criarDbPostgres } from '../src/db/db.js';
import { garantirPortao, migrar } from '../src/db/migrar.js';

const config = carregarConfig();
const db = criarDbPostgres(config.databaseUrl);
try {
  const aplicadas = await migrar(db);
  await garantirPortao(db, config.portao);
  console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(', ')}` : 'Banco já está atualizado.');
} finally {
  await db.fechar();
}
