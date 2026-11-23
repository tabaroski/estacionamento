import { randomUUID } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import {
  MensagemComando,
  topicos,
  type Acao,
  type EstadoPortao,
  type MensagemAck,
  type StatusAck,
} from '../portao/contrato.js';

export interface OpcoesSimulador {
  url: string;
  portaoId: string;
  usuario?: string;
  senha?: string;
  estadoInicial?: EstadoPortao;
  /** Tempo para o portão abrir ou fechar por completo. Padrão 6 s. */
  tempoCursoMs?: number;
  /** Atraso antes de tratar cada comando (simula rede lenta). Padrão 0. */
  atrasoMs?: number;
  /** Recebe comandos e não responde (simula placa travada). */
  mudo?: boolean;
  /** Fecha sozinho depois de aberto, como a fotocélula seguidora. 0 = desligado. */
  fecharSozinhoMs?: number;
  /** Intervalo mínimo entre pulsos nos relés. Padrão 2 s. */
  intervaloPulsosMs?: number;
  /** Publica o estado periodicamente. Padrão 60 s. */
  batimentoMs?: number;
  relogio?: () => number;
  registrar?: (linha: string) => void;
}

/**
 * Comporta-se como o firmware do ESP32 descrito em docs/contrato-mqtt.md:
 * valida cada comando, dá o "pulso" no relé, responde o ack e simula o
 * movimento do portão com os reed switches.
 */
export class Esp32Simulado {
  estado: EstadoPortao;
  /** Pulsos dados nos relés, para conferência nos testes. */
  readonly pulsos: { acao: Acao; em: number }[] = [];

  private cliente: MqttClient | null = null;
  private ultimosIds: string[] = [];
  private ultimoPulso = Number.NEGATIVE_INFINITY;
  private temporizadores = new Set<NodeJS.Timeout>();
  private movimento: NodeJS.Timeout | null = null;
  private batimento: NodeJS.Timeout | null = null;
  private readonly t: ReturnType<typeof topicos>;

  constructor(private readonly o: OpcoesSimulador) {
    this.estado = o.estadoInicial ?? 'FECHADO';
    this.t = topicos(o.portaoId);
  }

  private agora(): number {
    return (this.o.relogio ?? Date.now)();
  }

  private registrar(linha: string): void {
    this.o.registrar?.(linha);
  }

  async iniciar(): Promise<void> {
    this.cliente = await mqtt.connectAsync(this.o.url, {
      clientId: `esp32-sim-${this.o.portaoId}-${randomUUID().slice(0, 6)}`,
      username: this.o.usuario,
      password: this.o.senha,
      reconnectPeriod: 2000,
      will: { topic: this.t.status, payload: Buffer.from('offline'), qos: 1, retain: true },
    });
    await this.cliente.subscribeAsync(this.t.cmd, { qos: 1 });
    this.cliente.on('message', (_topico, payload) => this.aoComando(payload));
    await this.anunciar();
    // Reconectou (ex.: queda de Wi-Fi): anuncia de novo, porque o Last Will pode ter disparado.
    this.cliente.on('connect', () => void this.anunciar());
    this.batimento = setInterval(() => void this.publicarEstado(), this.o.batimentoMs ?? 60_000);
  }

  private async anunciar(): Promise<void> {
    await this.cliente?.publishAsync(this.t.status, 'online', { qos: 1, retain: true });
    await this.publicarEstado();
    this.registrar(`Conectado. Portão ${this.estado}.`);
  }

  /** Desliga de forma normal: avisa offline antes de sair. */
  async parar(): Promise<void> {
    this.limparTemporizadores();
    if (!this.cliente) return;
    await this.cliente.publishAsync(this.t.status, 'offline', { qos: 1, retain: true });
    await this.cliente.endAsync();
    this.cliente = null;
  }

  /** Simula falta de energia: a conexão cai sem aviso e o broker dispara o Last Will. */
  async derrubar(): Promise<void> {
    this.limparTemporizadores();
    if (!this.cliente) return;
    this.cliente.options.reconnectPeriod = 0;
    this.cliente.stream.destroy();
    await this.cliente.endAsync(true).catch(() => {});
    this.cliente = null;
  }

  /** Regras do contrato, na ordem: inválido, duplicado, expirado, executado. */
  avaliar(mensagem: unknown, agora: number): { status: StatusAck; comando?: MensagemComando } {
    const r = MensagemComando.safeParse(mensagem);
    if (!r.success) return { status: 'INVALIDO' };
    const c = r.data;
    if (this.ultimosIds.includes(c.id)) return { status: 'DUPLICADO', comando: c };
    if (agora - c.emitido_em > c.validade_ms) return { status: 'EXPIRADO', comando: c };
    this.ultimosIds.push(c.id);
    if (this.ultimosIds.length > 20) this.ultimosIds.shift();
    return { status: 'EXECUTADO', comando: c };
  }

  private aoComando(payload: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(payload.toString());
    } catch {
      this.registrar('Comando ilegível, ignorado.');
      return;
    }
    if (this.o.mudo) {
      this.registrar('Modo mudo: comando recebido e ignorado.');
      return;
    }
    const tratar = () => {
      const r = this.avaliar(json, this.agora());
      const idBruto = (json as { id?: unknown } | null)?.id;
      const id = r.comando?.id ?? (typeof idBruto === 'string' ? idBruto : null);
      if (!id) return; // sem id não há como responder
      const curto = id.slice(0, 8);
      if (r.status !== 'EXECUTADO') {
        this.registrar(`Comando ${r.comando?.acao ?? '?'} (${curto}): ${r.status}.`);
        void this.publicarAck({ id, status: r.status });
        return;
      }
      const acao = r.comando!.acao;
      const espera = Math.max(0, this.ultimoPulso + (this.o.intervaloPulsosMs ?? 2000) - this.agora());
      this.agendar(() => void this.pulsar(id, acao), espera);
    };
    if (this.o.atrasoMs) this.agendar(tratar, this.o.atrasoMs);
    else tratar();
  }

  private async pulsar(id: string, acao: Acao): Promise<void> {
    const em = this.agora();
    this.ultimoPulso = em;
    this.pulsos.push({ acao, em });
    this.registrar(`Comando ${acao} (${id.slice(0, 8)}): EXECUTADO. Pulso de 500 ms no borne ${acao === 'ABRIR' ? 'ABR' : 'FEC'}.`);
    // O ack sai antes da mudança dos reeds, como no portão real (o motor leva um instante para mover).
    await this.publicarAck({ id, status: 'EXECUTADO', executado_em: em });
    this.mover(acao === 'ABRIR' ? 'ABERTO' : 'FECHADO');
  }

  private mover(alvo: 'ABERTO' | 'FECHADO'): void {
    if (this.estado === alvo) return;
    if (this.movimento) clearTimeout(this.movimento);
    const curso = this.o.tempoCursoMs ?? 6000;
    this.agendar(() => void this.mudarEstado('PARCIAL'), Math.min(200, curso / 4));
    this.movimento = this.agendar(() => {
      void this.mudarEstado(alvo);
      const fecharSozinho = this.o.fecharSozinhoMs ?? 0;
      if (alvo === 'ABERTO' && fecharSozinho > 0) {
        this.agendar(() => {
          this.registrar('Carro passou: a central fecha o portão sozinha.');
          this.mover('FECHADO');
        }, fecharSozinho);
      }
    }, curso);
  }

  private async mudarEstado(estado: EstadoPortao): Promise<void> {
    if (this.estado === estado) return;
    this.estado = estado;
    this.registrar(`Reed switches: portão ${estado}.`);
    await this.publicarEstado();
  }

  private async publicarEstado(): Promise<void> {
    await this.cliente
      ?.publishAsync(this.t.estado, JSON.stringify({ estado: this.estado, em: this.agora() }), {
        qos: 1,
        retain: true,
      })
      .catch(() => {});
  }

  private async publicarAck(ack: MensagemAck): Promise<void> {
    await this.cliente?.publishAsync(this.t.ack, JSON.stringify(ack), { qos: 1 }).catch(() => {});
  }

  private agendar(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.temporizadores.delete(t);
      fn();
    }, ms);
    this.temporizadores.add(t);
    return t;
  }

  private limparTemporizadores(): void {
    for (const t of this.temporizadores) clearTimeout(t);
    this.temporizadores.clear();
    if (this.batimento) clearInterval(this.batimento);
    this.batimento = null;
    this.movimento = null;
  }
}
