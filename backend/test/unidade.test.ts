import { describe, expect, it } from 'vitest';
import { celularValido, cpfValido } from '../src/auth/documentos.js';
import { lerTopico } from '../src/portao/contrato.js';
import { avaliarPermissao } from '../src/portao/permissoes.js';
import { Esp32Simulado } from '../src/simulador/esp32-simulado.js';
import { IntervaloMinimo, LimiteJanela } from '../src/util/limitadores.js';

describe('documentos', () => {
  it('valida os dígitos do CPF', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('11144477735')).toBe(true);
    expect(cpfValido('529.982.247-26')).toBe(false);
    expect(cpfValido('111.111.111-11')).toBe(false);
    expect(cpfValido('123')).toBe(false);
  });

  it('valida celular com DDD', () => {
    expect(celularValido('(41) 99999-0000')).toBe(true);
    expect(celularValido('4133330000')).toBe(true);
    expect(celularValido('99999-0000')).toBe(false);
  });
});

describe('permissões do portão', () => {
  const sem = { temSessaoAtiva: false };
  const com = { temSessaoAtiva: true };

  it('admin e operador podem abrir e fechar', () => {
    for (const papel of ['admin', 'operador'] as const) {
      expect(avaliarPermissao({ papel, ativo: true }, 'ABRIR', sem).ok).toBe(true);
      expect(avaliarPermissao({ papel, ativo: true }, 'FECHAR', sem).ok).toBe(true);
    }
  });

  it('cliente só fecha, e só com sessão ativa', () => {
    expect(avaliarPermissao({ papel: 'cliente', ativo: true }, 'ABRIR', com).ok).toBe(false);
    expect(avaliarPermissao({ papel: 'cliente', ativo: true }, 'FECHAR', sem).ok).toBe(false);
    expect(avaliarPermissao({ papel: 'cliente', ativo: true }, 'FECHAR', com).ok).toBe(true);
  });

  it('ninguém desativado aciona o portão', () => {
    expect(avaliarPermissao({ papel: 'admin', ativo: false }, 'ABRIR', sem)).toEqual({
      ok: false,
      motivo: 'usuário desativado',
    });
  });
});

describe('regras do ESP32 (contrato)', () => {
  const novo = () => new Esp32Simulado({ url: 'mqtt://nao-usado', portaoId: 'principal' });
  const cmd = (id: string, emitido: number) => ({ id, acao: 'ABRIR', emitido_em: emitido, validade_ms: 5000 });

  it('executa um comando válido e recusa a repetição', () => {
    const sim = novo();
    expect(sim.avaliar(cmd('a', 1000), 1500).status).toBe('EXECUTADO');
    expect(sim.avaliar(cmd('a', 1000), 1600).status).toBe('DUPLICADO');
  });

  it('expira comando mais velho que a validade (o limite exato ainda vale)', () => {
    const sim = novo();
    expect(sim.avaliar(cmd('b', 1000), 6000).status).toBe('EXECUTADO');
    expect(sim.avaliar(cmd('c', 1000), 6001).status).toBe('EXPIRADO');
  });

  it('recusa mensagem fora do contrato', () => {
    const sim = novo();
    expect(sim.avaliar({ id: 'd', acao: 'GIRAR', emitido_em: 1, validade_ms: 1 }, 1).status).toBe('INVALIDO');
    expect(sim.avaliar({ acao: 'ABRIR' }, 1).status).toBe('INVALIDO');
  });

  it('lembra só os últimos 20 ids', () => {
    const sim = novo();
    for (let i = 0; i < 21; i++) sim.avaliar(cmd(`id-${i}`, 0), 0);
    expect(sim.avaliar(cmd('id-0', 0), 0).status).toBe('EXECUTADO');
    expect(sim.avaliar(cmd('id-20', 0), 0).status).toBe('DUPLICADO');
  });
});

describe('limitadores', () => {
  it('intervalo mínimo entre ações da mesma chave', () => {
    let agora = 0;
    const limite = new IntervaloMinimo(3000, () => agora);
    expect(limite.tentar('u1')).toBe(0);
    agora = 1000;
    expect(limite.tentar('u1')).toBe(2000);
    expect(limite.tentar('u2')).toBe(0);
    agora = 3000;
    expect(limite.tentar('u1')).toBe(0);
  });

  it('máximo de tentativas por janela', () => {
    let agora = 0;
    const limite = new LimiteJanela(2, 1000, () => agora);
    expect(limite.permitir('x')).toBe(true);
    expect(limite.permitir('x')).toBe(true);
    expect(limite.permitir('x')).toBe(false);
    agora = 1000;
    expect(limite.permitir('x')).toBe(true);
  });
});

describe('tópicos MQTT', () => {
  it('lê portão e tipo do tópico', () => {
    expect(lerTopico('estac/principal/ack')).toEqual({ portaoId: 'principal', tipo: 'ack' });
    expect(lerTopico('estac/principal/outro')).toBeNull();
    expect(lerTopico('outra/coisa')).toBeNull();
  });
});
