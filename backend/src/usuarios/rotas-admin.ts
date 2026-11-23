import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { ErroHttp, validar } from '../erros.js';
import { PAPEIS, paraPublico, type Usuario } from './usuarios.js';

const Alteracao = z
  .object({
    papel: z.enum(PAPEIS as [string, ...string[]]).optional(),
    ativo: z.boolean().optional(),
  })
  .refine((d) => d.papel !== undefined || d.ativo !== undefined, 'envie papel e/ou ativo');

const Id = z.object({ id: z.uuid('id inválido') });

export async function rotasAdminUsuarios(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;
  const soAdmin = { preHandler: [app.autenticar, app.exigirPapel('admin')] };

  app.get('/admin/usuarios', soAdmin, async () => {
    const lista = await db.query<Usuario>(
      'SELECT id, nome, email, celular, cpf, papel, ativo, criado_em FROM usuarios ORDER BY criado_em DESC',
    );
    return { usuarios: lista.map(paraPublico) };
  });

  app.patch('/admin/usuarios/:id', soAdmin, async (req) => {
    const { id } = validar(Id, req.params);
    const alteracao = validar(Alteracao, req.body);
    if (id === req.usuario!.id) {
      throw new ErroHttp(400, 'Você não pode alterar o próprio papel ou se desativar');
    }
    const [u] = await db.query<Usuario>(
      `UPDATE usuarios
       SET papel = COALESCE($2, papel), ativo = COALESCE($3, ativo)
       WHERE id = $1
       RETURNING id, nome, email, celular, cpf, papel, ativo, criado_em`,
      [id, alteracao.papel ?? null, alteracao.ativo ?? null],
    );
    if (!u) throw new ErroHttp(404, 'Usuário não encontrado');
    if (alteracao.ativo === false) {
      // Desativado: encerra as sessões de login dele.
      await db.query(
        'UPDATE tokens_renovacao SET revogado_em = now() WHERE usuario_id = $1 AND revogado_em IS NULL',
        [id],
      );
    }
    return { usuario: paraPublico(u) };
  });
}
