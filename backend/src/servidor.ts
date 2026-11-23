import { criarApp } from './app.js';
import { carregarConfig } from './config.js';
import { criarDbPostgres } from './db/db.js';
import { garantirPortao, migrar } from './db/migrar.js';
import { conectarPonte } from './portao/ponte-mqtt.js';

const config = carregarConfig();
const db = criarDbPostgres(config.databaseUrl);

const aplicadas = await migrar(db);
await garantirPortao(db, config.portao);

const { app, servico } = await criarApp({ config, db, logger: true });
if (aplicadas.length) app.log.info({ aplicadas }, 'Migrações aplicadas');

const ponte = conectarPonte(config.mqtt, servico, app.log);
servico.usarPonte(ponte);

await app.listen({ port: config.porta, host: config.host });

let encerrando = false;
async function encerrar(sinal: string) {
  if (encerrando) return;
  encerrando = true;
  app.log.info(`Recebido ${sinal}, encerrando`);
  await app.close();
  await ponte.fechar();
  await db.fechar();
  process.exit(0);
}
process.on('SIGINT', () => void encerrar('SIGINT'));
process.on('SIGTERM', () => void encerrar('SIGTERM'));
