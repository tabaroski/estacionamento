import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { ErroHttp, validar } from '../erros.js';
import { IntervaloMinimo, type Relogio } from '../util/limitadores.js';
import { ACOES, type EstadoPortao } from './contrato.js';
import {
  comandoPublico,
  SELECT_COMANDO,
  STATUS_COMANDO,
  type LinhaComando,
  type ServicoComandos,
  type StatusComando,
} from './servico-comandos.js';

const NovoComando = z.object({
  acao: z.enum(ACOES),
  origem: z.enum(['APP', 'PAINEL']).default('APP'),
});

const Filtros = z.object({
  de: z.string().optional(),
  ate: z.string().optional(),
  usuario: z.string().trim().min(1).optional(),
  acao: z.enum(ACOES).optional(),
  status: z.enum(STATUS_COMANDO).optional(),
  limite: z.coerce.number().int().min(1).max(500).default(100),
  formato: z.enum(['json', 'csv']).default('json'),
});

const CODIGO_HTTP: Record<StatusComando, number> = {
  EXECUTADO: 200,
  PENDENTE: 202,
  RECUSADO: 403,
  SEM_RESPOSTA: 504,
  EXPIRADO: 504,
  FALHOU: 502,
};

function lerData(texto: string | undefined, campo: string): Date | undefined {
  if (texto === undefined) return undefined;
  const data = new Date(texto);
  if (Number.isNaN(data.getTime())) throw new ErroHttp(400, `Data inválida em "${campo}"`);
  return data;
}

const horaBrasilia = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'medium',
});
const formatarHora = (d: Date | null): string => (d ? horaBrasilia.format(d) : '');

function celulaCsv(valor: string): string {
  return /[";\n\r]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

/** CSV com ";" e BOM, para abrir direto no Excel em português. */
function paraCsv(linhas: LinhaComando[]): string {
  const cabecalho = [
    'enviado_em',
    'executado_em',
    'movimentou_em',
    'usuario',
    'acao',
    'motivo',
    'origem',
    'status',
    'estado_antes',
    'estado_depois',
    'erro',
  ];
  const corpo = linhas.map((c) =>
    [
      formatarHora(c.enviado_em),
      formatarHora(c.executado_em),
      formatarHora(c.movimentou_em),
      c.usuario_email ?? '',
      c.acao,
      c.motivo,
      c.origem,
      c.status,
      c.estado_antes ?? '',
      c.estado_depois ?? '',
      c.erro ?? '',
    ]
      .map(celulaCsv)
      .join(';'),
  );
  return `﻿${[cabecalho.join(';'), ...corpo].join('\r\n')}\r\n`;
}

export async function rotasPortao(
  app: FastifyInstance,
  deps: { db: Db; config: Config; servico: ServicoComandos; relogio: Relogio },
): Promise<void> {
  const { db, config, servico } = deps;
  const intervalo = new IntervaloMinimo(config.comandoIntervaloMinMs, deps.relogio);

  app.post(
    '/comandos',
    { preHandler: [app.autenticar], config: { permiteInativo: true } },
    async (req, reply) => {
      const dados = validar(NovoComando, req.body);
      const usuario = req.usuario!;
      const faltaMs = intervalo.tentar(usuario.id);
      if (faltaMs > 0) {
        return reply
          .code(429)
          .send({ erro: 'Aguarde um instante antes de enviar outro comando', tenteEmMs: faltaMs });
      }
      const comando = await servico.enviar({
        usuario,
        acao: dados.acao,
        motivo: 'MANUAL',
        origem: dados.origem,
      });
      const corpo: Record<string, unknown> = { comando: comandoPublico(comando) };
      if (comando.status !== 'EXECUTADO') corpo.erro = comando.erro ?? comando.status;
      return reply.code(CODIGO_HTTP[comando.status]).send(corpo);
    },
  );

  app.get('/portao', { preHandler: [app.autenticar] }, async () => {
    const [p] = await db.query<{
      id: string;
      nome: string;
      capacidade_vagas: number | null;
      estado_atual: EstadoPortao;
      online: boolean;
      ultimo_contato_em: Date | null;
    }>('SELECT id, nome, capacidade_vagas, estado_atual, online, ultimo_contato_em FROM portoes WHERE id = $1', [
      config.portao.id,
    ]);
    if (!p) throw new ErroHttp(404, 'Portão não cadastrado');
    return {
      portao: {
        id: p.id,
        nome: p.nome,
        estado: p.estado_atual,
        online: p.online,
        ultimoContatoEm: p.ultimo_contato_em?.toISOString() ?? null,
        capacidadeVagas: p.capacidade_vagas,
      },
    };
  });

  app.get('/comandos/meus', { preHandler: [app.autenticar] }, async (req) => {
    const linhas = await db.query<LinhaComando>(
      `${SELECT_COMANDO} WHERE c.usuario_id = $1 ORDER BY c.enviado_em DESC LIMIT 50`,
      [req.usuario!.id],
    );
    return { comandos: linhas.map(comandoPublico) };
  });

  app.get(
    '/admin/comandos',
    { preHandler: [app.autenticar, app.exigirPapel('operador', 'admin')] },
    async (req, reply) => {
      const f = validar(Filtros, req.query);
      const condicoes: string[] = [];
      const params: unknown[] = [];
      const adicionar = (sql: string, valor: unknown) => {
        params.push(valor);
        condicoes.push(sql.replace('?', `$${params.length}`));
      };
      const de = lerData(f.de, 'de');
      const ate = lerData(f.ate, 'ate');
      if (de) adicionar('c.enviado_em >= ?', de);
      if (ate) adicionar('c.enviado_em <= ?', ate);
      if (f.usuario) adicionar('u.email ILIKE ?', `%${f.usuario}%`);
      if (f.acao) adicionar('c.acao = ?', f.acao);
      if (f.status) adicionar('c.status = ?', f.status);
      params.push(f.limite);
      const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
      const linhas = await db.query<LinhaComando>(
        `${SELECT_COMANDO} ${where} ORDER BY c.enviado_em DESC LIMIT $${params.length}`,
        params,
      );
      if (f.formato === 'csv') {
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="comandos.csv"')
          .send(paraCsv(linhas));
      }
      return { comandos: linhas.map(comandoPublico) };
    },
  );
}
