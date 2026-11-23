# Backend

API do app do estacionamento: usuários, comandos do portão com log e ponte MQTT
com o ESP32. Node 22 + TypeScript + Fastify + PostgreSQL + MQTT.

## Rodar no seu PC

Pré-requisitos: Node 22 ou mais novo e Docker Desktop.

```bash
# na raiz do repositório: banco e broker MQTT
docker compose up -d

cd backend
cp .env.example .env        # no Windows: copy .env.example .env
npm install
npm run criar-admin -- --email voce@email.com --nome "Seu Nome" --senha "uma-senha-forte"
npm run dev                 # API em http://localhost:3000
```

Em outro terminal, o ESP32 simulado:

```bash
cd backend
npm run sim:esp32
```

O arquivo `requisicoes.http` tem as chamadas prontas (extensão REST Client do VS Code).

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run dev` | API com recarga automática |
| `npm test` | Todos os testes (banco e broker em memória, não precisa de Docker) |
| `npm run typecheck` | Confere os tipos |
| `npm run migrar` | Aplica migrações pendentes (o servidor também faz isso ao iniciar) |
| `npm run criar-admin` | Cria um admin, ou promove quem já tem conta |
| `npm run sim:esp32` | ESP32 simulado (opções abaixo) |
| `npm run build` e `npm start` | Versão de produção |

### Opções do ESP32 simulado

| Opção | Simula |
| --- | --- |
| `--curso-s 6` | Tempo para abrir ou fechar por completo |
| `--fecha-sozinho 15` | Central fechando sozinha 15 s depois de abrir (fotocélula seguidora) |
| `--atraso-ms 7000` | Rede lenta: os comandos chegam vencidos e voltam `EXPIRADO` |
| `--mudo` | Placa travada: o backend registra `SEM_RESPOSTA` |
| `--aberto` | Começar com o portão aberto |

Use assim: `npm run sim:esp32 -- --mudo`.

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| GET | `/saude` | Público | Banco e conexão MQTT |
| POST | `/auth/cadastro` | Público | Cria cliente (nome, e-mail, celular, CPF, senha) |
| POST | `/auth/login` | Público | Devolve token de acesso (15 min) e de renovação (30 dias) |
| POST | `/auth/renovar` | Público | Troca o token de renovação por um par novo |
| POST | `/auth/sair` | Público | Invalida o token de renovação |
| GET | `/me` | Logado | Dados do usuário |
| GET | `/portao` | Logado | Estado, online/offline e último contato |
| POST | `/comandos` | Operador e admin; cliente só FECHAR com sessão | Abre ou fecha e espera o resultado |
| GET | `/comandos/meus` | Logado | Últimos 50 comandos do usuário |
| GET | `/admin/comandos` | Operador e admin | Log com filtros `de`, `ate`, `usuario`, `acao`, `status`, `limite` e `formato=csv` |
| GET | `/admin/usuarios` | Admin | Lista de usuários |
| PATCH | `/admin/usuarios/:id` | Admin | Muda `papel` e/ou `ativo` |

Resposta de `POST /comandos` por resultado: `EXECUTADO` 200, `RECUSADO` 403,
`SEM_RESPOSTA` e `EXPIRADO` 504, `FALHOU` 502, limite de 1 comando a cada 3 s 429.

## Log de comandos

Todo comando é gravado antes de ir ao portão, inclusive os recusados, com três horários:

1. `enviado_em`: quando o app pediu.
2. `executado_em`: quando o ESP32 deu o pulso (vem no ack).
3. `movimentou_em`: primeira mudança dos reed switches depois disso.

`estado_antes` e `estado_depois` mostram o portão antes e depois. O contrato com a
placa está em [`docs/contrato-mqtt.md`](../docs/contrato-mqtt.md).

## Estrutura

```
src/
  app.ts                 monta a API (usada pelo servidor e pelos testes)
  servidor.ts            liga banco, MQTT e porta HTTP
  config.ts              variáveis de ambiente validadas
  db/                    acesso ao banco e migrações
  auth/                  cadastro, login, tokens, CPF
  usuarios/              usuários e rotas de admin
  portao/                contrato MQTT, ponte, permissões, comandos e rotas
  simulador/             ESP32 simulado
scripts/                 migrar, criar-admin, sim:esp32
test/                    testes automáticos
```
