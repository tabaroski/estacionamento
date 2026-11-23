import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autorizacao, esperarAte, montarAmbiente, type Ambiente } from './ajudantes.js';

const enviar = (amb: Ambiente, token: string, acao: 'ABRIR' | 'FECHAR') =>
  amb.app.inject({ method: 'POST', url: '/comandos', headers: autorizacao(token), payload: { acao } });

const linha = async (amb: Ambiente, id: string) => {
  const [l] = await amb.db.query<{
    status: string;
    executado_em: Date | null;
    movimentou_em: Date | null;
    estado_depois: string | null;
  }>('SELECT status, executado_em, movimentou_em, estado_depois FROM comandos WHERE id = $1', [id]);
  return l!;
};

describe('comandos do portão com o ESP32 simulado', () => {
  let amb: Ambiente;

  beforeAll(async () => {
    amb = await montarAmbiente();
  });
  afterAll(async () => {
    await amb.fechar();
  });

  it('admin abre o portão: EXECUTADO, com os três horários e o estado final', async () => {
    const { token } = await amb.usuario('admin');
    const r = await enviar(amb, token, 'ABRIR');

    expect(r.statusCode).toBe(200);
    const c = r.json().comando;
    expect(c.status).toBe('EXECUTADO');
    expect(c.estadoAntes).toBe('FECHADO');
    expect(Date.parse(c.executadoEm)).toBeGreaterThanOrEqual(Date.parse(c.enviadoEm));
    expect(amb.sim!.pulsos.at(-1)?.acao).toBe('ABRIR');

    // Terceiro horário e estado final chegam pelos reed switches.
    await esperarAte(async () => (await linha(amb, c.id)).estado_depois === 'ABERTO');
    const l = await linha(amb, c.id);
    expect(l.movimentou_em!.getTime()).toBeGreaterThanOrEqual(l.executado_em!.getTime());
    expect((await amb.portao()).estado_atual).toBe('ABERTO');

    // Eventos depois do comando (antes dele há o FECHADO inicial que a placa informa ao ligar).
    const eventos = await amb.db.query<{ tipo: string }>(
      'SELECT tipo FROM eventos_portao WHERE ocorrido_em >= $1 ORDER BY ocorrido_em, id',
      [new Date(c.enviadoEm)],
    );
    expect(eventos.map((e) => e.tipo)).toEqual(['PARCIAL', 'ABERTO']);
  });

  it('operador fecha o portão', async () => {
    const { token } = await amb.usuario('operador');
    const r = await enviar(amb, token, 'FECHAR');
    expect(r.statusCode).toBe(200);
    expect(r.json().comando.estadoAntes).toBe('ABERTO');
    await esperarAte(async () => (await amb.portao()).estado_atual === 'FECHADO');
  });

  it('cliente não abre o portão por comando manual: RECUSADO e registrado no log', async () => {
    const { token, usuario } = await amb.usuario('cliente');
    const pulsosAntes = amb.sim!.pulsos.length;

    const r = await enviar(amb, token, 'ABRIR');
    expect(r.statusCode).toBe(403);
    expect(r.json().comando.status).toBe('RECUSADO');
    expect(r.json().erro).toContain('entrar e sair');

    const registros = await amb.db.query<{ status: string }>('SELECT status FROM comandos WHERE usuario_id = $1', [
      usuario.id,
    ]);
    expect(registros.map((x) => x.status)).toEqual(['RECUSADO']);
    expect(amb.sim!.pulsos.length).toBe(pulsosAntes);
  });

  it('cliente sem sessão também não fecha', async () => {
    const { token } = await amb.usuario('cliente');
    const r = await enviar(amb, token, 'FECHAR');
    expect(r.statusCode).toBe(403);
    expect(r.json().erro).toContain('durante uma sessão');
  });

  it('usuário desativado tem o comando recusado e registrado', async () => {
    const { token, usuario } = await amb.usuario('operador');
    await amb.db.query('UPDATE usuarios SET ativo = false WHERE id = $1', [usuario.id]);
    const r = await enviar(amb, token, 'ABRIR');
    expect(r.statusCode).toBe(403);
    expect(r.json().comando.status).toBe('RECUSADO');
    expect(r.json().comando.erro).toBe('usuário desativado');
  });

  it('GET /portao mostra o estado e se está online', async () => {
    const { token } = await amb.usuario('cliente');
    const r = await amb.app.inject({ method: 'GET', url: '/portao', headers: autorizacao(token) });
    expect(r.statusCode).toBe(200);
    expect(r.json().portao).toMatchObject({ id: 'principal', estado: 'FECHADO', online: true });
  });

  it('GET /comandos/meus traz só os comandos de quem pediu', async () => {
    const { token, usuario } = await amb.usuario('operador');
    await enviar(amb, token, 'FECHAR');
    const r = await amb.app.inject({ method: 'GET', url: '/comandos/meus', headers: autorizacao(token) });
    const comandos = r.json().comandos;
    expect(comandos).toHaveLength(1);
    expect(comandos[0].usuario.id).toBe(usuario.id);
  });

  it('log do painel: mais novo primeiro, com filtros, e exportação em CSV', async () => {
    const admin = await amb.usuario('admin');
    const todos = await amb.app.inject({ method: 'GET', url: '/admin/comandos', headers: autorizacao(admin.token) });
    expect(todos.statusCode).toBe(200);
    const lista = todos.json().comandos as { enviadoEm: string; status: string }[];
    expect(lista.length).toBeGreaterThanOrEqual(5);
    const datas = lista.map((c) => Date.parse(c.enviadoEm));
    expect(datas).toEqual([...datas].sort((a, b) => b - a));

    const recusados = await amb.app.inject({
      method: 'GET',
      url: '/admin/comandos?status=RECUSADO',
      headers: autorizacao(admin.token),
    });
    const statusRecusados = recusados.json().comandos.map((c: { status: string }) => c.status);
    expect(statusRecusados.length).toBeGreaterThanOrEqual(3);
    expect(new Set(statusRecusados)).toEqual(new Set(['RECUSADO']));

    const csv = await amb.app.inject({
      method: 'GET',
      url: '/admin/comandos?formato=csv',
      headers: autorizacao(admin.token),
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.startsWith('﻿enviado_em;executado_em;movimentou_em;usuario;acao')).toBe(true);
    expect(csv.body).toContain(';EXECUTADO;');

    const cliente = await amb.usuario('cliente');
    const negado = await amb.app.inject({ method: 'GET', url: '/admin/comandos', headers: autorizacao(cliente.token) });
    expect(negado.statusCode).toBe(403);
  });
});

describe('falhas de comunicação com o portão', () => {
  let amb: Ambiente;
  let token: string;

  beforeAll(async () => {
    amb = await montarAmbiente({ simulador: false });
    token = (await amb.usuario('admin')).token;
  });
  afterAll(async () => {
    await amb.fechar();
  });

  it('placa travada: SEM_RESPOSTA depois da validade + margem', async () => {
    const sim = await amb.ligarSimulador({ mudo: true });
    const inicio = Date.now();
    const r = await enviar(amb, token, 'ABRIR');
    const duracao = Date.now() - inicio;

    expect(r.statusCode).toBe(504);
    expect(r.json().comando.status).toBe('SEM_RESPOSTA');
    expect(r.json().erro).toBe('o portão não respondeu a tempo');
    expect(duracao).toBeGreaterThanOrEqual(amb.config.comandoValidadeMs + amb.config.comandoMargemMs - 50);
    expect(sim.pulsos).toHaveLength(0);
    await sim.parar();
  });

  it('comando que chega vencido: EXPIRADO e o portão não se mexe', async () => {
    const sim = await amb.ligarSimulador({ atrasoMs: amb.config.comandoValidadeMs + 100 });
    const r = await enviar(amb, token, 'ABRIR');
    expect(r.statusCode).toBe(504);
    expect(r.json().comando.status).toBe('EXPIRADO');
    expect(sim.pulsos).toHaveLength(0);
    await sim.parar();
  });

  it('ack atrasado depois do tempo limite ainda atualiza o log', async () => {
    // Relógio da placa 1 s atrás: o comando ainda está válido para ela, mas o ack chega tarde.
    const sim = await amb.ligarSimulador({
      atrasoMs: amb.config.comandoValidadeMs + amb.config.comandoMargemMs + 200,
      relogio: () => Date.now() - 1000,
    });
    const r = await enviar(amb, token, 'ABRIR');
    expect(r.json().comando.status).toBe('SEM_RESPOSTA');
    await esperarAte(async () => (await linha(amb, r.json().comando.id)).status === 'EXECUTADO');
    await sim.parar();
  });

  it('placa sem energia: offline no painel e SEM_RESPOSTA com o motivo', async () => {
    const sim = await amb.ligarSimulador();
    await sim.derrubar();
    await esperarAte(async () => !(await amb.portao()).online);

    const r = await enviar(amb, token, 'ABRIR');
    expect(r.statusCode).toBe(504);
    expect(r.json().erro).toBe('portão offline');

    const [evento] = await amb.db.query<{ tipo: string }>(
      "SELECT tipo FROM eventos_portao WHERE tipo IN ('ONLINE', 'OFFLINE') ORDER BY id DESC LIMIT 1",
    );
    expect(evento!.tipo).toBe('OFFLINE');
  });
});

describe('limite de comandos por usuário', () => {
  let amb: Ambiente;

  beforeAll(async () => {
    amb = await montarAmbiente({ config: { comandoIntervaloMinMs: 3000 } });
  });
  afterAll(async () => {
    await amb.fechar();
  });

  it('segundo comando em menos de 3 s é recusado com 429', async () => {
    const { token } = await amb.usuario('admin');
    expect((await enviar(amb, token, 'ABRIR')).statusCode).toBe(200);
    const r = await enviar(amb, token, 'FECHAR');
    expect(r.statusCode).toBe(429);
    expect(r.json().tenteEmMs).toBeGreaterThan(0);
  });
});
