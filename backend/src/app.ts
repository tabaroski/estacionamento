import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { ErroHttp } from './erros.js';
import { registrarAutenticacao } from './auth/autenticacao.js';
import { rotasAutenticacao } from './auth/rotas.js';
import { rotasAdminUsuarios } from './usuarios/rotas-admin.js';
import { rotasPortao } from './portao/rotas.js';
import { ServicoComandos } from './portao/servico-comandos.js';
import type { Relogio } from './util/limitadores.js';

export interface OpcoesApp {
  config: Config;
  db: Db;
  relogio?: Relogio;
  /** true = logs no console (servidor); false = silencioso (testes). */
  logger?: boolean;
}

/**
 * Monta a API sem abrir porta e sem conectar no MQTT: quem chama decide.
 * Assim os testes usam a mesma app com banco e broker em memória.
 */
export async function criarApp(
  opcoes: OpcoesApp,
): Promise<{ app: FastifyInstance; servico: ServicoComandos }> {
  const { config, db } = opcoes;
  const relogio = opcoes.relogio ?? Date.now;

  const app = Fastify({
    logger: opcoes.logger
      ? { level: 'info', redact: ['req.headers.authorization', 'req.body.senha', 'req.body.renovacao'] }
      : false,
    trustProxy: true,
  });

  await app.register(cors, { origin: config.corsOrigens });

  app.setErrorHandler((erro, req, reply) => {
    if (erro instanceof ErroHttp) {
      return reply
        .code(erro.status)
        .send(erro.detalhes ? { erro: erro.message, detalhes: erro.detalhes } : { erro: erro.message });
    }
    const status = (erro as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ erro: (erro as Error).message });
    }
    req.log.error(erro);
    return reply.code(500).send({ erro: 'Erro interno. Tente de novo em instantes.' });
  });

  const servico = new ServicoComandos({
    db,
    config,
    relogio,
    log: app.log,
    // Etapa de sessões: trocar por uma consulta à tabela de sessões.
    temSessaoAtiva: async () => false,
  });

  await registrarAutenticacao(app, db, config);
  await rotasAutenticacao(app, { db, config, relogio });
  await rotasAdminUsuarios(app, { db });
  await rotasPortao(app, { db, config, servico, relogio });

  app.get('/saude', async () => {
    await db.query('SELECT 1');
    return { ok: true, mqtt: servico.ponteConectada() };
  });

  return { app, servico };
}
