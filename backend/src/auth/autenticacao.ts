import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { buscarPorId, type Papel, type Usuario } from '../usuarios/usuarios.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; papel: Papel };
    user: { sub: string; papel: Papel };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Exige token válido e carrega o usuário do banco. */
    autenticar: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Exige um dos papéis (use depois de autenticar). */
    exigirPapel: (...papeis: Papel[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    usuario: Usuario | null;
  }
  interface FastifyContextConfig {
    /** A rota recebe usuário desativado (para registrar a recusa no log). */
    permiteInativo?: boolean;
  }
}

export interface Tokens {
  acesso: string;
  renovacao: string;
  acessoExpiraEmSegundos: number;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function registrarAutenticacao(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.jwtSegredo,
    sign: { expiresIn: `${config.tokenAcessoMin}m` },
  });

  app.decorateRequest('usuario', null);

  app.decorate('autenticar', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ erro: 'Faça login novamente' });
    }
    const usuario = await buscarPorId(db, req.user.sub);
    if (!usuario) return reply.code(401).send({ erro: 'Faça login novamente' });
    if (!usuario.ativo && !req.routeOptions.config.permiteInativo) {
      return reply.code(403).send({ erro: 'Usuário desativado' });
    }
    req.usuario = usuario;
  });

  app.decorate('exigirPapel', (...papeis: Papel[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.usuario || !papeis.includes(req.usuario.papel)) {
      return reply.code(403).send({ erro: 'Sem permissão para esta ação' });
    }
  });
}

/** Emite um token de acesso (curto) e um de renovação (longo, guardado só como hash). */
export async function emitirTokens(app: FastifyInstance, db: Db, config: Config, usuario: Usuario): Promise<Tokens> {
  const acesso = app.jwt.sign({ sub: usuario.id, papel: usuario.papel });
  const renovacao = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO tokens_renovacao (usuario_id, token_hash, expira_em)
     VALUES ($1, $2, now() + make_interval(days => $3::int))`,
    [usuario.id, hashToken(renovacao), config.refreshDias],
  );
  return { acesso, renovacao, acessoExpiraEmSegundos: config.tokenAcessoMin * 60 };
}
