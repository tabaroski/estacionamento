import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autorizacao, montarAmbiente, type Ambiente } from './ajudantes.js';

const CPF_VALIDO = '529.982.247-25';
const OUTRO_CPF_VALIDO = '111.444.777-35';

describe('cadastro, login e papéis', () => {
  let amb: Ambiente;

  beforeAll(async () => {
    amb = await montarAmbiente({ simulador: false });
  });
  afterAll(async () => {
    await amb.fechar();
  });

  const cadastrar = (ajustes: Record<string, unknown> = {}) =>
    amb.app.inject({
      method: 'POST',
      url: '/auth/cadastro',
      payload: {
        nome: 'Ana Souza',
        email: 'Ana@Exemplo.com ',
        celular: '(41) 99999-0000',
        cpf: CPF_VALIDO,
        senha: 'senha-forte-1',
        ...ajustes,
      },
    });

  const login = (email: string, senha: string) =>
    amb.app.inject({ method: 'POST', url: '/auth/login', payload: { email, senha } });

  const renovar = (renovacao: string) =>
    amb.app.inject({ method: 'POST', url: '/auth/renovar', payload: { renovacao } });

  it('cadastra um cliente e devolve os tokens', async () => {
    const r = await cadastrar();
    expect(r.statusCode).toBe(201);
    const corpo = r.json();
    expect(corpo.usuario).toMatchObject({
      nome: 'Ana Souza',
      email: 'ana@exemplo.com',
      celular: '41999990000',
      cpf: '***.***.247-25',
      papel: 'cliente',
      ativo: true,
    });
    expect(corpo.tokens.acesso).toEqual(expect.any(String));
    expect(corpo.tokens.renovacao).toEqual(expect.any(String));
  });

  it('não aceita e-mail repetido', async () => {
    const r = await cadastrar({ cpf: OUTRO_CPF_VALIDO });
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toBe('E-mail já cadastrado');
  });

  it('não aceita CPF repetido', async () => {
    const r = await cadastrar({ email: 'outra@exemplo.com' });
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toBe('CPF já cadastrado');
  });

  it('recusa dados inválidos e diz quais campos', async () => {
    const r = await cadastrar({ email: 'x@exemplo.com', cpf: '123.456.789-00', senha: '123', celular: '999' });
    expect(r.statusCode).toBe(400);
    const campos = r.json().detalhes.map((d: { campo: string }) => d.campo);
    expect(campos).toEqual(expect.arrayContaining(['cpf', 'senha', 'celular']));
  });

  it('faz login com a senha certa e recusa a errada', async () => {
    const certo = await login('ana@exemplo.com', 'senha-forte-1');
    expect(certo.statusCode).toBe(200);
    expect(certo.json().usuario.email).toBe('ana@exemplo.com');

    const errado = await login('ana@exemplo.com', 'senha-errada');
    expect(errado.statusCode).toBe(401);
    expect(errado.json().erro).toBe('E-mail ou senha incorretos');
  });

  it('GET /me exige token', async () => {
    const sem = await amb.app.inject({ method: 'GET', url: '/me' });
    expect(sem.statusCode).toBe(401);

    const token = (await login('ana@exemplo.com', 'senha-forte-1')).json().tokens.acesso;
    const com = await amb.app.inject({ method: 'GET', url: '/me', headers: autorizacao(token) });
    expect(com.statusCode).toBe(200);
    expect(com.json().usuario.email).toBe('ana@exemplo.com');
  });

  it('renova o token, e reapresentar um token já usado derruba as sessões', async () => {
    const primeiro = (await login('ana@exemplo.com', 'senha-forte-1')).json().tokens.renovacao;

    const r1 = await renovar(primeiro);
    expect(r1.statusCode).toBe(200);
    const segundo = r1.json().tokens.renovacao;
    expect(segundo).not.toBe(primeiro);

    // Reuso do primeiro (possível vazamento): recusado e o segundo também cai.
    expect((await renovar(primeiro)).statusCode).toBe(401);
    expect((await renovar(segundo)).statusCode).toBe(401);
  });

  it('sair invalida o token de renovação', async () => {
    const renovacao = (await login('ana@exemplo.com', 'senha-forte-1')).json().tokens.renovacao;
    const sair = await amb.app.inject({ method: 'POST', url: '/auth/sair', payload: { renovacao } });
    expect(sair.statusCode).toBe(204);
    expect((await renovar(renovacao)).statusCode).toBe(401);
  });

  it('cliente não acessa rotas de admin', async () => {
    const { token } = await amb.usuario('cliente');
    const r = await amb.app.inject({ method: 'GET', url: '/admin/usuarios', headers: autorizacao(token) });
    expect(r.statusCode).toBe(403);
  });

  it('admin desativa um usuário: ele não entra mais e o token antigo para de valer', async () => {
    const admin = await amb.usuario('admin');
    const alvo = await amb.usuario('cliente');

    const r = await amb.app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${alvo.usuario.id}`,
      headers: autorizacao(admin.token),
      payload: { ativo: false },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().usuario.ativo).toBe(false);

    expect((await login(alvo.usuario.email, alvo.senha)).statusCode).toBe(403);
    const me = await amb.app.inject({ method: 'GET', url: '/me', headers: autorizacao(alvo.token) });
    expect(me.statusCode).toBe(403);
  });

  it('admin promove um cliente a operador', async () => {
    const admin = await amb.usuario('admin');
    const alvo = await amb.usuario('cliente');
    const r = await amb.app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${alvo.usuario.id}`,
      headers: autorizacao(admin.token),
      payload: { papel: 'operador' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().usuario.papel).toBe('operador');
  });

  it('admin não pode se desativar', async () => {
    const admin = await amb.usuario('admin');
    const r = await amb.app.inject({
      method: 'PATCH',
      url: `/admin/usuarios/${admin.usuario.id}`,
      headers: autorizacao(admin.token),
      payload: { ativo: false },
    });
    expect(r.statusCode).toBe(400);
  });

  it('bloqueia tentativas de login em sequência', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login('forca-bruta@exemplo.com', `tentativa-${i}`)).statusCode).toBe(401);
    }
    expect((await login('forca-bruta@exemplo.com', 'mais-uma')).statusCode).toBe(429);
  });
});
