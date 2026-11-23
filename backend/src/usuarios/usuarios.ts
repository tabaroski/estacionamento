import type { Db } from '../db/db.js';

export type Papel = 'cliente' | 'operador' | 'admin';
export const PAPEIS: readonly Papel[] = ['cliente', 'operador', 'admin'];

export interface Usuario {
  id: string;
  nome: string;
  email: string;
  celular: string | null;
  cpf: string | null;
  papel: Papel;
  ativo: boolean;
  criado_em: Date;
}

const CAMPOS = 'id, nome, email, celular, cpf, papel, ativo, criado_em';

export async function buscarPorId(db: Db, id: string): Promise<Usuario | null> {
  const [u] = await db.query<Usuario>(`SELECT ${CAMPOS} FROM usuarios WHERE id = $1`, [id]);
  return u ?? null;
}

export async function buscarPorEmailComSenha(
  db: Db,
  email: string,
): Promise<(Usuario & { senha_hash: string }) | null> {
  const [u] = await db.query<Usuario & { senha_hash: string }>(
    `SELECT ${CAMPOS}, senha_hash FROM usuarios WHERE email = $1`,
    [email],
  );
  return u ?? null;
}

export async function criarUsuario(
  db: Db,
  dados: {
    nome: string;
    email: string;
    celular: string | null;
    cpf: string | null;
    senhaHash: string;
    papel: Papel;
  },
): Promise<Usuario> {
  const [u] = await db.query<Usuario>(
    `INSERT INTO usuarios (nome, email, celular, cpf, senha_hash, papel)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${CAMPOS}`,
    [dados.nome, dados.email, dados.celular, dados.cpf, dados.senhaHash, dados.papel],
  );
  return u!;
}

/** Dados que podem sair na API. O CPF só aparece mascarado. */
export function paraPublico(u: Usuario) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email,
    celular: u.celular,
    cpf: u.cpf ? `***.***.${u.cpf.slice(6, 9)}-${u.cpf.slice(9)}` : null,
    papel: u.papel,
    ativo: u.ativo,
    criadoEm: u.criado_em.toISOString(),
  };
}

export const normalizarEmail = (email: string): string => email.trim().toLowerCase();
