import { hash, verify } from '@node-rs/argon2';

/** Argon2id com os parâmetros padrão da biblioteca. */
export function gerarHashSenha(senha: string): Promise<string> {
  return hash(senha);
}

export async function conferirSenha(hashSalvo: string, senha: string): Promise<boolean> {
  try {
    return await verify(hashSalvo, senha);
  } catch {
    return false;
  }
}
