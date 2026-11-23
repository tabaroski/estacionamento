import type { Usuario } from '../usuarios/usuarios.js';
import type { Acao } from './contrato.js';

export type Permissao = { ok: true } | { ok: false; motivo: string };

/**
 * Quem pode acionar o portão por comando manual.
 * Operador e admin: sempre. Cliente: só fechar, e só durante uma sessão.
 * (Entrar e sair com pagamento chegam na etapa de sessões.)
 */
export function avaliarPermissao(
  usuario: Pick<Usuario, 'papel' | 'ativo'>,
  acao: Acao,
  contexto: { temSessaoAtiva: boolean },
): Permissao {
  if (!usuario.ativo) return { ok: false, motivo: 'usuário desativado' };
  if (usuario.papel === 'admin' || usuario.papel === 'operador') return { ok: true };
  if (acao === 'FECHAR') {
    return contexto.temSessaoAtiva
      ? { ok: true }
      : { ok: false, motivo: 'o cliente só fecha o portão durante uma sessão' };
  }
  return { ok: false, motivo: 'o cliente abre o portão pelas opções de entrar e sair' };
}
