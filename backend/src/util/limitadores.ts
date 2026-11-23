/** Relógio injetável, para os testes controlarem o tempo. */
export type Relogio = () => number;

/** Exige um intervalo mínimo entre ações da mesma chave (ex.: comandos por usuário). */
export class IntervaloMinimo {
  private ultimo = new Map<string, number>();

  constructor(
    private readonly intervaloMs: number,
    private readonly agora: Relogio = Date.now,
  ) {}

  /** Retorna 0 se pode agir agora (e registra), ou quantos ms faltam. */
  tentar(chave: string): number {
    const t = this.agora();
    const anterior = this.ultimo.get(chave);
    if (anterior !== undefined && t - anterior < this.intervaloMs) {
      return this.intervaloMs - (t - anterior);
    }
    this.ultimo.set(chave, t);
    return 0;
  }
}

/** No máximo N tentativas por janela de tempo (ex.: tentativas de login). */
export class LimiteJanela {
  private tentativas = new Map<string, number[]>();

  constructor(
    private readonly maximo: number,
    private readonly janelaMs: number,
    private readonly agora: Relogio = Date.now,
  ) {}

  permitir(chave: string): boolean {
    const t = this.agora();
    const recentes = (this.tentativas.get(chave) ?? []).filter((x) => t - x < this.janelaMs);
    if (recentes.length >= this.maximo) {
      this.tentativas.set(chave, recentes);
      return false;
    }
    recentes.push(t);
    this.tentativas.set(chave, recentes);
    return true;
  }

  limpar(chave: string): void {
    this.tentativas.delete(chave);
  }
}
