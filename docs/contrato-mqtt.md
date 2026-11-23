# Contrato MQTT entre o backend e o portão

Este é o acordo entre o backend e o dispositivo do portão. O ESP32 simulado
(`backend/src/simulador/`) já segue este contrato. Quando o firmware real for
escrito, basta cumprir o mesmo contrato para trocar o simulado pela placa sem
mudar o backend.

`{portao}` é o identificador do portão (variável `PORTAO_ID`, padrão `principal`).

## Tópicos

| Tópico | Quem publica | Conteúdo | QoS / retain |
| --- | --- | --- | --- |
| `estac/{portao}/cmd` | Backend | Comando de abrir ou fechar | QoS 1 |
| `estac/{portao}/ack` | Dispositivo | Resultado de cada comando | QoS 1 |
| `estac/{portao}/estado` | Dispositivo | Estado do portão pelos reed switches | QoS 1, retain |
| `estac/{portao}/status` | Dispositivo (e Last Will) | `online` ou `offline` | QoS 1, retain |

## Mensagens

Todos os horários são em milissegundos desde 1970 (UTC), como `Date.now()`.

**Comando** (`cmd`)

```json
{ "id": "6f1c…", "acao": "ABRIR", "emitido_em": 1795432000000, "validade_ms": 5000 }
```

- `acao`: `ABRIR` ou `FECHAR`.
- `id`: UUID único por comando.

**Confirmação** (`ack`)

```json
{ "id": "6f1c…", "status": "EXECUTADO", "executado_em": 1795432000120 }
```

- `status`: `EXECUTADO`, `EXPIRADO`, `DUPLICADO` ou `INVALIDO`.
- `executado_em`: horário do pulso no borne, só quando `EXECUTADO`.

**Estado** (`estado`)

```json
{ "estado": "ABERTO", "em": 1795432002100 }
```

- `estado`: `ABERTO`, `FECHADO`, `PARCIAL` (entre os dois reeds) ou `INDEFINIDO`.

**Status** (`status`): texto puro, `online` ou `offline`.

## Regras do dispositivo

1. Ao conectar, publicar `online` (retain) em `status` e o estado atual (retain) em `estado`.
2. Registrar o Last Will `offline` (QoS 1, retain) em `status`.
3. Para cada comando, responder um `ack`, nesta ordem de verificação:
    1. Campos ausentes ou `acao` desconhecida: `INVALIDO`.
    2. `id` entre os últimos 20 executados: `DUPLICADO` (o QoS 1 pode entregar duas vezes).
    3. `agora − emitido_em > validade_ms`: `EXPIRADO`. Um comando atrasado nunca aciona o portão.
    4. Caso contrário: pulso de 500 ms no borne ABR ou FEC e `EXECUTADO`.
4. Nunca acionar ABR e FEC ao mesmo tempo; intervalo mínimo de 2 s entre pulsos.
5. Sem horário válido (NTP), recusar comandos com `EXPIRADO`.
6. Publicar `estado` a cada mudança dos reeds e a cada 60 s.

## Como o backend usa as mensagens

- Grava o comando no log **antes** de publicar, inclusive quando recusa.
- Espera o `ack` por `validade_ms + 1 s`. Sem resposta, marca `SEM_RESPOSTA`.
  Um `ack` que chegue depois ainda atualiza o registro.
- `executado_em` do `ack` vira o segundo horário do log.
- A primeira mudança de `estado` até 30 s depois da execução vira o terceiro
  horário (`movimentou_em`). O estado final (`ABERTO` ou `FECHADO`) vai para
  `estado_depois`.

## Produção

- TLS na porta 8883; o dispositivo só abre conexão de saída.
- Usuário e senha próprios por dispositivo.
- ACL no broker: o dispositivo só lê o próprio `cmd` e só publica o próprio
  `ack`, `estado` e `status`. O backend lê e publica em `estac/#`.
