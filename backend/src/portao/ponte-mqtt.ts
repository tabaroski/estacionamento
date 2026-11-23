import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import {
  lerTopico,
  MensagemAck,
  MensagemEstado,
  topicos,
  type MensagemComando,
} from './contrato.js';

export interface Registro {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** Quem recebe o que chega do portão. `retida` = mensagem guardada pelo broker, não ao vivo. */
export interface OuvintesPonte {
  aoAck(portaoId: string, ack: MensagemAck): Promise<void>;
  aoEstado(portaoId: string, estado: MensagemEstado, retida: boolean): Promise<void>;
  aoStatus(portaoId: string, online: boolean, retida: boolean): Promise<void>;
}

export interface Ponte {
  publicarComando(portaoId: string, comando: MensagemComando): Promise<void>;
  conectada(): boolean;
  /** Resolve quando a primeira conexão e as inscrições estiverem prontas. */
  pronta(): Promise<void>;
  fechar(): Promise<void>;
}

export function conectarPonte(
  opcoes: { url: string; usuario?: string; senha?: string },
  ouvintes: OuvintesPonte,
  log: Registro,
): Ponte {
  const cliente = mqtt.connect(opcoes.url, {
    clientId: `backend-${randomUUID().slice(0, 8)}`,
    username: opcoes.usuario,
    password: opcoes.senha,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
  });

  let marcarPronta: () => void = () => {};
  const prontaPromessa = new Promise<void>((resolve) => (marcarPronta = resolve));

  cliente.on('connect', () => {
    cliente.subscribe(['estac/+/ack', 'estac/+/estado', 'estac/+/status'], { qos: 1 }, (erro) => {
      if (erro) {
        log.error({ erro: erro.message }, 'MQTT: falha ao se inscrever nos tópicos');
        return;
      }
      log.info('MQTT conectado e inscrito nos tópicos do portão');
      marcarPronta();
    });
  });
  cliente.on('reconnect', () => log.warn('MQTT: tentando reconectar'));
  cliente.on('error', (erro) => log.warn({ erro: erro.message }, 'MQTT: erro de conexão'));

  // Processa uma mensagem por vez, na ordem de chegada (a ordem dos estados importa).
  let fila: Promise<void> = Promise.resolve();

  cliente.on('message', (topico, payload, pacote) => {
    fila = fila
      .then(async () => {
        const alvo = lerTopico(topico);
        if (!alvo) return;
        const texto = payload.toString();
        if (alvo.tipo === 'status') {
          if (texto !== 'online' && texto !== 'offline') return;
          await ouvintes.aoStatus(alvo.portaoId, texto === 'online', pacote.retain);
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(texto);
        } catch {
          log.warn({ topico }, 'MQTT: mensagem que não é JSON, ignorada');
          return;
        }
        if (alvo.tipo === 'ack') {
          const ack = MensagemAck.safeParse(json);
          if (ack.success) await ouvintes.aoAck(alvo.portaoId, ack.data);
          else log.warn({ topico }, 'MQTT: ack fora do contrato, ignorado');
        } else if (alvo.tipo === 'estado') {
          const estado = MensagemEstado.safeParse(json);
          if (estado.success) await ouvintes.aoEstado(alvo.portaoId, estado.data, pacote.retain);
          else log.warn({ topico }, 'MQTT: estado fora do contrato, ignorado');
        }
      })
      .catch((erro: unknown) => {
        log.error({ erro: String(erro), topico }, 'Erro ao tratar mensagem do portão');
      });
  });

  return {
    async publicarComando(portaoId, comando) {
      await cliente.publishAsync(topicos(portaoId).cmd, JSON.stringify(comando), { qos: 1 });
    },
    conectada: () => cliente.connected,
    pronta: () => prontaPromessa,
    async fechar() {
      await cliente.endAsync();
    },
  };
}
