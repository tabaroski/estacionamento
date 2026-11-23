/**
 * Contrato MQTT com o dispositivo do portão (veja docs/contrato-mqtt.md).
 * Usado pelo backend e pelo ESP32 simulado; o firmware real segue o mesmo.
 */
import { z } from 'zod';

export const ACOES = ['ABRIR', 'FECHAR'] as const;
export type Acao = (typeof ACOES)[number];

export const ESTADOS = ['ABERTO', 'FECHADO', 'PARCIAL', 'INDEFINIDO'] as const;
export type EstadoPortao = (typeof ESTADOS)[number];

export const STATUS_ACK = ['EXECUTADO', 'EXPIRADO', 'DUPLICADO', 'INVALIDO'] as const;
export type StatusAck = (typeof STATUS_ACK)[number];

export type TipoTopico = 'cmd' | 'ack' | 'estado' | 'status';

export function topicos(portaoId: string): Record<TipoTopico, string> {
  return {
    cmd: `estac/${portaoId}/cmd`,
    ack: `estac/${portaoId}/ack`,
    estado: `estac/${portaoId}/estado`,
    status: `estac/${portaoId}/status`,
  };
}

export function lerTopico(topico: string): { portaoId: string; tipo: TipoTopico } | null {
  const m = /^estac\/([a-z0-9-]+)\/(cmd|ack|estado|status)$/.exec(topico);
  return m ? { portaoId: m[1]!, tipo: m[2] as TipoTopico } : null;
}

export const MensagemComando = z.object({
  id: z.string().min(1),
  acao: z.enum(ACOES),
  emitido_em: z.number(),
  validade_ms: z.number().int().positive(),
});
export type MensagemComando = z.infer<typeof MensagemComando>;

export const MensagemAck = z.object({
  id: z.string().min(1),
  status: z.enum(STATUS_ACK),
  executado_em: z.number().optional(),
});
export type MensagemAck = z.infer<typeof MensagemAck>;

export const MensagemEstado = z.object({
  estado: z.enum(ESTADOS),
  em: z.number(),
});
export type MensagemEstado = z.infer<typeof MensagemEstado>;
