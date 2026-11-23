import net, { type AddressInfo } from 'node:net';
import { Aedes } from 'aedes';
import type { FastifyInstance } from 'fastify';
import { criarApp } from '../src/app.js';
import { gerarHashSenha } from '../src/auth/senha.js';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { garantirPortao } from '../src/db/migrar.js';
import { conectarPonte, type Ponte, type Registro } from '../src/portao/ponte-mqtt.js';
import type { ServicoComandos } from '../src/portao/servico-comandos.js';
import { Esp32Simulado, type OpcoesSimulador } from '../src/simulador/esp32-simulado.js';
import { criarUsuario, type Papel, type Usuario } from '../src/usuarios/usuarios.js';
import { criarDbMemoria } from './db-memoria.js';

export const silencioso: Registro = { info() {}, warn() {}, error() {} };

/** Broker MQTT de verdade, em memória, numa porta livre. */
export async function iniciarBroker(): Promise<{ url: string; fechar: () => Promise<void> }> {
  const aedes = await Aedes.createBroker();
  const servidor = net.createServer(aedes.handle);
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = (servidor.address() as AddressInfo).port;
  return {
    url: `mqtt://127.0.0.1:${porta}`,
    async fechar() {
      await new Promise<void>((ok) => aedes.close(() => ok()));
      await new Promise<void>((ok) => servidor.close(() => ok()));
    },
  };
}

export function configDeTeste(urlMqtt: string, ajustes: Partial<Config> = {}): Config {
  return {
    porta: 0,
    host: '127.0.0.1',
    databaseUrl: 'memoria',
    mqtt: { url: urlMqtt },
    jwtSegredo: 'segredo-so-para-testes-com-mais-de-32-caracteres',
    tokenAcessoMin: 15,
    refreshDias: 30,
    portao: { id: 'principal', nome: 'Portão principal' },
    // Tempos curtos para os testes rodarem rápido.
    comandoValidadeMs: 400,
    comandoMargemMs: 300,
    comandoIntervaloMinMs: 0,
    corsOrigens: ['http://localhost:5173'],
    ...ajustes,
  };
}

export async function esperarAte(condicao: () => Promise<boolean> | boolean, limiteMs = 3000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`Condição não atingida em ${limiteMs} ms`);
}

export interface Ambiente {
  db: Db;
  app: FastifyInstance;
  servico: ServicoComandos;
  ponte: Ponte;
  sim: Esp32Simulado | null;
  brokerUrl: string;
  config: Config;
  /** Cria um usuário direto no banco e devolve o token de acesso dele. */
  usuario(papel: Papel, email?: string): Promise<{ usuario: Usuario; token: string; senha: string }>;
  /** Liga um ESP32 simulado (o ambiente pode começar sem nenhum). */
  ligarSimulador(opcoes?: Partial<OpcoesSimulador>): Promise<Esp32Simulado>;
  portao(): Promise<{ estado_atual: string; online: boolean }>;
  fechar(): Promise<void>;
}

let contador = 0;

export async function montarAmbiente(
  opcoes: { config?: Partial<Config>; simulador?: Partial<OpcoesSimulador> | false } = {},
): Promise<Ambiente> {
  const db = await criarDbMemoria();
  const broker = await iniciarBroker();
  const config = configDeTeste(broker.url, opcoes.config);
  await garantirPortao(db, config.portao);
  const { app, servico } = await criarApp({ config, db });
  await app.ready();
  const ponte = conectarPonte(config.mqtt, servico, silencioso);
  servico.usarPonte(ponte);
  await ponte.pronta();

  const simuladores: Esp32Simulado[] = [];

  const ambiente: Ambiente = {
    db,
    app,
    servico,
    ponte,
    sim: null,
    brokerUrl: broker.url,
    config,
    async usuario(papel, email) {
      const senha = 'senha-de-teste-123';
      const usuario = await criarUsuario(db, {
        nome: `Pessoa ${papel}`,
        email: email ?? `${papel}${++contador}@exemplo.com`,
        celular: null,
        cpf: null,
        senhaHash: await gerarHashSenha(senha),
        papel,
      });
      const r = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: usuario.email, senha },
      });
      return { usuario, token: r.json().tokens.acesso as string, senha };
    },
    async ligarSimulador(o = {}) {
      const sim = new Esp32Simulado({
        url: broker.url,
        portaoId: config.portao.id,
        tempoCursoMs: 80,
        intervaloPulsosMs: 0,
        ...o,
      });
      await sim.iniciar();
      simuladores.push(sim);
      ambiente.sim = sim;
      await esperarAte(async () => (await ambiente.portao()).online);
      return sim;
    },
    async portao() {
      const [p] = await db.query<{ estado_atual: string; online: boolean }>(
        'SELECT estado_atual, online FROM portoes WHERE id = $1',
        [config.portao.id],
      );
      return p!;
    },
    async fechar() {
      for (const s of simuladores) await s.parar().catch(() => {});
      await ponte.fechar();
      await app.close();
      await broker.fechar();
      await db.fechar();
    },
  };

  if (opcoes.simulador !== false) await ambiente.ligarSimulador(opcoes.simulador ?? {});
  return ambiente;
}

export const autorizacao = (token: string) => ({ authorization: `Bearer ${token}` });
