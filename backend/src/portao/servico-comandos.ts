import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { Relogio } from '../util/limitadores.js';
import type { Usuario } from '../usuarios/usuarios.js';
import type { Acao, EstadoPortao, MensagemAck, MensagemEstado } from './contrato.js';
import { avaliarPermissao } from './permissoes.js';
import type { OuvintesPonte, Ponte, Registro } from './ponte-mqtt.js';

export type Motivo = 'ENTRADA' | 'SAIDA' | 'MANUAL';
export type Origem = 'APP' | 'PAINEL' | 'SISTEMA';
export const STATUS_COMANDO = [
  'PENDENTE',
  'EXECUTADO',
  'EXPIRADO',
  'RECUSADO',
  'SEM_RESPOSTA',
  'FALHOU',
] as const;
export type StatusComando = (typeof STATUS_COMANDO)[number];

export interface LinhaComando {
  id: string;
  portao_id: string;
  usuario_id: string | null;
  usuario_email: string | null;
  usuario_nome: string | null;
  acao: Acao;
  motivo: Motivo;
  origem: Origem;
  status: StatusComando;
  validade_ms: number;
  enviado_em: Date;
  executado_em: Date | null;
  movimentou_em: Date | null;
  estado_antes: EstadoPortao | null;
  estado_depois: EstadoPortao | null;
  erro: string | null;
}

export const SELECT_COMANDO = `
  SELECT c.id, c.portao_id, c.usuario_id, u.email AS usuario_email, u.nome AS usuario_nome,
         c.acao, c.motivo, c.origem, c.status, c.validade_ms, c.enviado_em, c.executado_em,
         c.movimentou_em, c.estado_antes, c.estado_depois, c.erro
  FROM comandos c LEFT JOIN usuarios u ON u.id = c.usuario_id`;

export function comandoPublico(c: LinhaComando) {
  return {
    id: c.id,
    portaoId: c.portao_id,
    usuario: c.usuario_id ? { id: c.usuario_id, email: c.usuario_email, nome: c.usuario_nome } : null,
    acao: c.acao,
    motivo: c.motivo,
    origem: c.origem,
    status: c.status,
    erro: c.erro,
    enviadoEm: c.enviado_em.toISOString(),
    executadoEm: c.executado_em?.toISOString() ?? null,
    movimentouEm: c.movimentou_em?.toISOString() ?? null,
    estadoAntes: c.estado_antes,
    estadoDepois: c.estado_depois,
  };
}

/** Tolerância para aceitar o relógio do dispositivo. Fora disso, usa o horário do servidor. */
const TOLERANCIA_RELOGIO_MS = 5 * 60_000;

export class ServicoComandos implements OuvintesPonte {
  private ponte: Ponte | null = null;
  private pendentes = new Map<string, () => void>();

  constructor(
    private readonly deps: {
      db: Db;
      config: Config;
      relogio: Relogio;
      log: Registro;
      /** Implementado na etapa de sessões. Até lá, nenhum cliente tem sessão. */
      temSessaoAtiva: (usuarioId: string) => Promise<boolean>;
    },
  ) {}

  usarPonte(ponte: Ponte): void {
    this.ponte = ponte;
  }

  ponteConectada(): boolean {
    return this.ponte?.conectada() ?? false;
  }

  /** Registra o comando, publica para o portão e espera o resultado (ou o tempo limite). */
  async enviar(p: { usuario: Usuario; acao: Acao; motivo: Motivo; origem: Origem }): Promise<LinhaComando> {
    const { db, config, relogio, log } = this.deps;
    const portaoId = config.portao.id;
    const [portao] = await db.query<{ estado_atual: EstadoPortao; online: boolean }>(
      'SELECT estado_atual, online FROM portoes WHERE id = $1',
      [portaoId],
    );
    const estadoAntes = portao?.estado_atual ?? 'INDEFINIDO';
    const agora = relogio();

    const temSessaoAtiva = p.usuario.papel === 'cliente' ? await this.deps.temSessaoAtiva(p.usuario.id) : false;
    const permissao = avaliarPermissao(p.usuario, p.acao, { temSessaoAtiva });

    const [registro] = await db.query<{ id: string }>(
      `INSERT INTO comandos
         (portao_id, usuario_id, acao, motivo, origem, status, validade_ms, enviado_em, estado_antes, erro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        portaoId,
        p.usuario.id,
        p.acao,
        p.motivo,
        p.origem,
        permissao.ok ? 'PENDENTE' : 'RECUSADO',
        config.comandoValidadeMs,
        new Date(agora),
        estadoAntes,
        permissao.ok ? null : permissao.motivo,
      ],
    );
    const id = registro!.id;
    if (!permissao.ok) return this.buscar(id);

    const espera = this.aguardarAck(id, config.comandoValidadeMs + config.comandoMargemMs);
    if (this.ponte) {
      // Não espera a publicação: se o broker estiver fora, o tempo limite resolve.
      this.ponte
        .publicarComando(portaoId, { id, acao: p.acao, emitido_em: agora, validade_ms: config.comandoValidadeMs })
        .catch((erro: unknown) => log.warn({ erro: String(erro), id }, 'Falha ao publicar comando'));
    }
    const desfecho = await espera;
    if (desfecho === 'TEMPO') {
      const motivo = !this.ponte?.conectada()
        ? 'backend sem conexão com o broker MQTT'
        : portao?.online
          ? 'o portão não respondeu a tempo'
          : 'portão offline';
      await db.query(
        `UPDATE comandos SET status = 'SEM_RESPOSTA', erro = $2 WHERE id = $1 AND status = 'PENDENTE'`,
        [id, motivo],
      );
    }
    return this.buscar(id);
  }

  async buscar(id: string): Promise<LinhaComando> {
    const [c] = await this.deps.db.query<LinhaComando>(`${SELECT_COMANDO} WHERE c.id = $1`, [id]);
    return c!;
  }

  private aguardarAck(id: string, ms: number): Promise<'ACK' | 'TEMPO'> {
    return new Promise((resolve) => {
      const tempo = setTimeout(() => {
        this.pendentes.delete(id);
        resolve('TEMPO');
      }, ms);
      this.pendentes.set(id, () => {
        clearTimeout(tempo);
        this.pendentes.delete(id);
        resolve('ACK');
      });
    });
  }

  private horarioDispositivo(ms: number | undefined): Date {
    const agora = this.deps.relogio();
    if (typeof ms === 'number' && Math.abs(ms - agora) <= TOLERANCIA_RELOGIO_MS) return new Date(ms);
    return new Date(agora);
  }

  // ---- Mensagens que chegam do portão ----

  async aoAck(portaoId: string, ack: MensagemAck): Promise<void> {
    const { db, log } = this.deps;
    if (ack.status === 'DUPLICADO') {
      log.info({ id: ack.id }, 'Portão recebeu um comando repetido e ignorou');
      return;
    }
    const mudanca =
      ack.status === 'EXECUTADO'
        ? { status: 'EXECUTADO', executadoEm: this.horarioDispositivo(ack.executado_em), erro: null }
        : ack.status === 'EXPIRADO'
          ? { status: 'EXPIRADO', executadoEm: null, erro: 'o comando chegou ao portão depois da validade' }
          : { status: 'FALHOU', executadoEm: null, erro: 'o portão não reconheceu o comando' };
    // Aceita ack atrasado (depois de SEM_RESPOSTA): o log fica com a verdade.
    await db.query(
      `UPDATE comandos SET status = $3, executado_em = $4, erro = $5
       WHERE id = $1 AND portao_id = $2 AND status IN ('PENDENTE', 'SEM_RESPOSTA')`,
      [ack.id, portaoId, mudanca.status, mudanca.executadoEm, mudanca.erro],
    );
    this.pendentes.get(ack.id)?.();
  }

  async aoEstado(portaoId: string, msg: MensagemEstado, retida: boolean): Promise<void> {
    const { db } = this.deps;
    const [atual] = await db.query<{ estado_atual: EstadoPortao }>(
      'SELECT estado_atual FROM portoes WHERE id = $1',
      [portaoId],
    );
    if (!atual) return;
    if (retida) {
      // Último estado conhecido, guardado pelo broker: atualiza sem gerar evento.
      await db.query('UPDATE portoes SET estado_atual = $2 WHERE id = $1', [portaoId, msg.estado]);
      return;
    }
    await db.query(
      'UPDATE portoes SET estado_atual = $2, online = true, ultimo_contato_em = now() WHERE id = $1',
      [portaoId, msg.estado],
    );
    if (atual.estado_atual === msg.estado) return; // só o batimento periódico

    const em = this.horarioDispositivo(msg.em);
    await db.query('INSERT INTO eventos_portao (portao_id, tipo, ocorrido_em) VALUES ($1, $2, $3)', [
      portaoId,
      msg.estado,
      em,
    ]);
    // Primeiro movimento depois de um comando executado: terceiro horário do log.
    await db.query(
      `UPDATE comandos SET movimentou_em = $2
       WHERE id = (
         SELECT id FROM comandos
         WHERE portao_id = $1 AND status = 'EXECUTADO' AND movimentou_em IS NULL
           AND executado_em BETWEEN $2::timestamptz - interval '30 seconds' AND $2::timestamptz
         ORDER BY executado_em DESC LIMIT 1)`,
      [portaoId, em],
    );
    // Estado em que o portão parou depois do comando.
    await db.query(
      `UPDATE comandos SET estado_depois = $3
       WHERE id = (
         SELECT id FROM comandos
         WHERE portao_id = $1 AND status = 'EXECUTADO'
           AND executado_em BETWEEN $2::timestamptz - interval '60 seconds' AND $2::timestamptz
           AND (estado_depois IS NULL OR estado_depois = 'PARCIAL')
         ORDER BY executado_em DESC LIMIT 1)`,
      [portaoId, em, msg.estado],
    );
  }

  async aoStatus(portaoId: string, online: boolean, retida: boolean): Promise<void> {
    const { db } = this.deps;
    const [atual] = await db.query<{ online: boolean }>('SELECT online FROM portoes WHERE id = $1', [portaoId]);
    if (!atual) return;
    await db.query(
      `UPDATE portoes SET online = $2,
         ultimo_contato_em = CASE WHEN $3::boolean THEN ultimo_contato_em ELSE now() END
       WHERE id = $1`,
      [portaoId, online, retida],
    );
    if (atual.online !== online) {
      await db.query('INSERT INTO eventos_portao (portao_id, tipo, ocorrido_em) VALUES ($1, $2, $3)', [
        portaoId,
        online ? 'ONLINE' : 'OFFLINE',
        new Date(this.deps.relogio()),
      ]);
    }
  }
}
