import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { ErroHttp, validar } from '../erros.js';
import { LimiteJanela, type Relogio } from '../util/limitadores.js';
import {
  buscarPorEmailComSenha,
  buscarPorId,
  criarUsuario,
  normalizarEmail,
  paraPublico,
} from '../usuarios/usuarios.js';
import { emitirTokens, hashToken } from './autenticacao.js';
import { celularValido, cpfValido, soDigitos } from './documentos.js';
import { conferirSenha, gerarHashSenha } from './senha.js';

const Cadastro = z.object({
  nome: z.string().trim().min(3, 'informe o nome completo').max(120),
  email: z.string().trim().toLowerCase().pipe(z.email('e-mail inválido')),
  celular: z.string().refine(celularValido, 'celular com DDD: 10 ou 11 dígitos'),
  cpf: z.string().refine(cpfValido, 'CPF inválido'),
  senha: z.string().min(8, 'a senha precisa de pelo menos 8 caracteres').max(200),
});

const Login = z.object({
  email: z.string().trim().toLowerCase(),
  senha: z.string().min(1).max(200),
});

const Renovacao = z.object({ renovacao: z.string().min(20).max(200) });

export async function rotasAutenticacao(
  app: FastifyInstance,
  deps: { db: Db; config: Config; relogio: Relogio },
): Promise<void> {
  const { db, config } = deps;
  // 10 tentativas de login a cada 10 min por e-mail + IP.
  const tentativasLogin = new LimiteJanela(10, 10 * 60_000, deps.relogio);

  app.post('/auth/cadastro', async (req, reply) => {
    const dados = validar(Cadastro, req.body);
    const cpf = soDigitos(dados.cpf);
    const [existente] = await db.query<{ email: string; cpf: string | null }>(
      'SELECT email, cpf FROM usuarios WHERE email = $1 OR cpf = $2',
      [dados.email, cpf],
    );
    if (existente) {
      throw new ErroHttp(409, existente.email === dados.email ? 'E-mail já cadastrado' : 'CPF já cadastrado');
    }
    const usuario = await criarUsuario(db, {
      nome: dados.nome,
      email: dados.email,
      celular: soDigitos(dados.celular),
      cpf,
      senhaHash: await gerarHashSenha(dados.senha),
      papel: 'cliente',
    });
    const tokens = await emitirTokens(app, db, config, usuario);
    return reply.code(201).send({ usuario: paraPublico(usuario), tokens });
  });

  app.post('/auth/login', async (req) => {
    const dados = validar(Login, req.body);
    const email = normalizarEmail(dados.email);
    const chave = `${email}|${req.ip}`;
    if (!tentativasLogin.permitir(chave)) {
      throw new ErroHttp(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    }
    const usuario = await buscarPorEmailComSenha(db, email);
    if (!usuario || !(await conferirSenha(usuario.senha_hash, dados.senha))) {
      throw new ErroHttp(401, 'E-mail ou senha incorretos');
    }
    if (!usuario.ativo) throw new ErroHttp(403, 'Usuário desativado');
    tentativasLogin.limpar(chave);
    const tokens = await emitirTokens(app, db, config, usuario);
    return { usuario: paraPublico(usuario), tokens };
  });

  app.post('/auth/renovar', async (req) => {
    const { renovacao } = validar(Renovacao, req.body);
    const [registro] = await db.query<{
      id: string;
      usuario_id: string;
      revogado_em: Date | null;
      expirado: boolean;
    }>(
      `SELECT id, usuario_id, revogado_em, expira_em < now() AS expirado
       FROM tokens_renovacao WHERE token_hash = $1`,
      [hashToken(renovacao)],
    );
    if (!registro) throw new ErroHttp(401, 'Faça login novamente');
    if (registro.revogado_em) {
      // Token já usado sendo reapresentado: pode ter vazado. Derruba todas as sessões do usuário.
      await db.query(
        'UPDATE tokens_renovacao SET revogado_em = now() WHERE usuario_id = $1 AND revogado_em IS NULL',
        [registro.usuario_id],
      );
      throw new ErroHttp(401, 'Faça login novamente');
    }
    if (registro.expirado) throw new ErroHttp(401, 'Faça login novamente');
    const usuario = await buscarPorId(db, registro.usuario_id);
    if (!usuario) throw new ErroHttp(401, 'Faça login novamente');
    if (!usuario.ativo) throw new ErroHttp(403, 'Usuário desativado');
    await db.query('UPDATE tokens_renovacao SET revogado_em = now() WHERE id = $1', [registro.id]);
    const tokens = await emitirTokens(app, db, config, usuario);
    return { usuario: paraPublico(usuario), tokens };
  });

  app.post('/auth/sair', async (req, reply) => {
    const { renovacao } = validar(Renovacao, req.body);
    await db.query(
      'UPDATE tokens_renovacao SET revogado_em = now() WHERE token_hash = $1 AND revogado_em IS NULL',
      [hashToken(renovacao)],
    );
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: [app.autenticar] }, async (req) => {
    return { usuario: paraPublico(req.usuario!) };
  });
}
