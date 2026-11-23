import type { ZodType } from 'zod';

/** Erro com status HTTP e mensagem para o app. */
export class ErroHttp extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
    readonly detalhes?: unknown,
  ) {
    super(mensagem);
  }
}

/** Valida a entrada com zod e devolve 400 com os campos problemáticos. */
export function validar<T>(esquema: ZodType<T>, dados: unknown): T {
  const r = esquema.safeParse(dados);
  if (!r.success) {
    const campos = r.error.issues.map((i) => ({ campo: i.path.join('.'), problema: i.message }));
    throw new ErroHttp(400, 'Dados inválidos', campos);
  }
  return r.data;
}
