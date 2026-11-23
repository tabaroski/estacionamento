import { z } from 'zod';

export interface Config {
  porta: number;
  host: string;
  databaseUrl: string;
  mqtt: { url: string; usuario?: string; senha?: string };
  jwtSegredo: string;
  tokenAcessoMin: number;
  refreshDias: number;
  portao: { id: string; nome: string };
  /** Validade do comando: o ESP32 descarta comandos mais velhos que isso. */
  comandoValidadeMs: number;
  /** Tempo extra que o backend espera pelo ack além da validade. */
  comandoMargemMs: number;
  /** Intervalo mínimo entre dois comandos do mesmo usuário. */
  comandoIntervaloMinMs: number;
  corsOrigens: string[];
}

const Ambiente = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  MQTT_URL: z.string().min(1, 'MQTT_URL é obrigatório'),
  MQTT_USUARIO: z.string().optional(),
  MQTT_SENHA: z.string().optional(),
  JWT_SEGREDO: z.string().min(32, 'JWT_SEGREDO precisa de pelo menos 32 caracteres'),
  TOKEN_ACESSO_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_DIAS: z.coerce.number().int().positive().default(30),
  PORTAO_ID: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'PORTAO_ID: só letras minúsculas, números e hífen')
    .default('principal'),
  PORTAO_NOME: z.string().default('Portão principal'),
  COMANDO_VALIDADE_MS: z.coerce.number().int().positive().default(5000),
  COMANDO_INTERVALO_MIN_MS: z.coerce.number().int().nonnegative().default(3000),
  CORS_ORIGEM: z.string().default('http://localhost:5173'),
  NODE_ENV: z.string().optional(),
});

/** Lê o .env (se existir) e as variáveis de ambiente, e valida tudo de uma vez. */
export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) {
    try {
      process.loadEnvFile();
    } catch {
      // Sem arquivo .env: usa só as variáveis do ambiente.
    }
  }
  const r = Ambiente.safeParse(env);
  if (!r.success) {
    const problemas = r.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${problemas}`);
  }
  const e = r.data;
  if (e.NODE_ENV === 'production' && e.JWT_SEGREDO.startsWith('troque')) {
    throw new Error('JWT_SEGREDO ainda é o valor de exemplo. Gere um segredo próprio antes de ir para produção.');
  }
  return {
    porta: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    mqtt: { url: e.MQTT_URL, usuario: e.MQTT_USUARIO, senha: e.MQTT_SENHA },
    jwtSegredo: e.JWT_SEGREDO,
    tokenAcessoMin: e.TOKEN_ACESSO_MIN,
    refreshDias: e.REFRESH_DIAS,
    portao: { id: e.PORTAO_ID, nome: e.PORTAO_NOME },
    comandoValidadeMs: e.COMANDO_VALIDADE_MS,
    comandoMargemMs: 1000,
    comandoIntervaloMinMs: e.COMANDO_INTERVALO_MIN_MS,
    corsOrigens: e.CORS_ORIGEM.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
