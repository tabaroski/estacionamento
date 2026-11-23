/**
 * Migrações em ordem. Nunca altere uma migração já aplicada:
 * crie uma nova no fim da lista.
 */
export const migracoes: { id: string; sql: string }[] = [
  {
    id: '001_inicial',
    sql: /* sql */ `
      CREATE TABLE usuarios (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        nome text NOT NULL,
        email text NOT NULL UNIQUE,
        celular text,
        cpf char(11) UNIQUE,
        senha_hash text NOT NULL,
        papel text NOT NULL DEFAULT 'cliente'
          CHECK (papel IN ('cliente', 'operador', 'admin')),
        ativo boolean NOT NULL DEFAULT true,
        criado_em timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE tokens_renovacao (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expira_em timestamptz NOT NULL,
        revogado_em timestamptz,
        criado_em timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX tokens_renovacao_usuario ON tokens_renovacao (usuario_id);

      CREATE TABLE portoes (
        id text PRIMARY KEY,
        nome text NOT NULL,
        capacidade_vagas integer,
        estado_atual text NOT NULL DEFAULT 'INDEFINIDO'
          CHECK (estado_atual IN ('ABERTO', 'FECHADO', 'PARCIAL', 'INDEFINIDO')),
        online boolean NOT NULL DEFAULT false,
        ultimo_contato_em timestamptz
      );

      CREATE TABLE comandos (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        portao_id text NOT NULL REFERENCES portoes (id),
        usuario_id uuid REFERENCES usuarios (id),
        acao text NOT NULL CHECK (acao IN ('ABRIR', 'FECHAR')),
        motivo text NOT NULL CHECK (motivo IN ('ENTRADA', 'SAIDA', 'MANUAL')),
        origem text NOT NULL CHECK (origem IN ('APP', 'PAINEL', 'SISTEMA')),
        status text NOT NULL CHECK (status IN
          ('PENDENTE', 'EXECUTADO', 'EXPIRADO', 'RECUSADO', 'SEM_RESPOSTA', 'FALHOU')),
        validade_ms integer NOT NULL,
        enviado_em timestamptz NOT NULL DEFAULT now(),
        executado_em timestamptz,
        movimentou_em timestamptz,
        estado_antes text,
        estado_depois text,
        erro text
      );
      CREATE INDEX comandos_enviado ON comandos (enviado_em DESC);
      CREATE INDEX comandos_usuario ON comandos (usuario_id, enviado_em DESC);

      CREATE TABLE eventos_portao (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        portao_id text NOT NULL REFERENCES portoes (id),
        tipo text NOT NULL CHECK (tipo IN
          ('ABERTO', 'FECHADO', 'PARCIAL', 'INDEFINIDO', 'ONLINE', 'OFFLINE')),
        ocorrido_em timestamptz NOT NULL,
        recebido_em timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX eventos_portao_ocorrido ON eventos_portao (portao_id, ocorrido_em DESC);
    `,
  },
];
