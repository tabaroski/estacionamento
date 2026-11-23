export const soDigitos = (texto: string): string => texto.replace(/\D/g, '');

/** Confere os dois dígitos verificadores do CPF. */
export function cpfValido(cpf: string): boolean {
  const d = soDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digito = (n: number): number => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

/** Celular brasileiro com DDD: 10 ou 11 dígitos. */
export const celularValido = (celular: string): boolean => /^\d{10,11}$/.test(soDigitos(celular));
