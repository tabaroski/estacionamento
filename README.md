# Estacionamento AV

App para o cliente entrar, sair e pagar pelo celular, com o portão acionado
pelo app e cada comando registrado em log.

| Pasta | O que é | Situação |
| --- | --- | --- |
| [`backend/`](backend/) | API: usuários, comandos do portão, log, ponte MQTT | Base pronta |
| [`app/`](app/) | PWA do cliente e painel do operador | Próxima etapa |
| [`firmware/`](firmware/) | ESP32 no portão | Etapa final (depois de conferir a central) |
| [`docs/`](docs/) | Contrato MQTT entre backend e portão | Pronto |

Enquanto o hardware não chega, o backend conversa com um **ESP32 simulado** que
segue o mesmo [contrato MQTT](docs/contrato-mqtt.md) que o firmware vai cumprir.

## Etapas

- [x] Estrutura do repositório, Docker Compose e CI
- [x] Backend base: cadastro, login, papéis, comandos do portão, log com três horários, ESP32 simulado
- [ ] App base (PWA): login, início, abrir/fechar, histórico
- [ ] Sessões e tarifa (R$ 8 por meia hora iniciada; diária a definir)
- [ ] Pagamento Pix (Mercado Pago)
- [ ] Cartão de crédito
- [ ] Painel admin
- [ ] Firmware, servidor e instalação no portão
- [ ] Piloto

## Começar

Pré-requisitos: Node 22 ou mais novo e Docker Desktop.

```bash
docker compose up -d
cd backend
cp .env.example .env        # no Windows: copy .env.example .env
npm install
npm test
```

O passo a passo completo está em [`backend/README.md`](backend/README.md).

## Roteiro de teste desta etapa

1. `npm test` dentro de `backend/`: todos os testes passam.
2. `npm run criar-admin -- --email voce@email.com --nome "Seu Nome" --senha "uma-senha-forte"`.
3. Terminal 1: `npm run dev`. Terminal 2: `npm run sim:esp32`.
4. Em `backend/requisicoes.http`, faça o login e envie **Abrir o portão**.
   - Esperado: resposta 200 com `EXECUTADO` em menos de 1 s.
   - No terminal do simulador: pulso, portão PARCIAL e ABERTO depois de 6 s.
5. **Log de comandos**: o comando aparece com `enviadoEm`, `executadoEm` e
   `movimentouEm`, `estadoAntes` FECHADO e `estadoDepois` ABERTO.
6. **Log em CSV**: abre no Excel com os horários de Brasília.
7. **Cadastro de cliente** e **Cliente tentando abrir**: resposta 403, e o comando
   aparece no log como `RECUSADO`.
8. Ctrl+C no simulador e **Estado do portão**: `online: false`. Mande abrir de novo:
   depois de uns 6 s, 504 com `SEM_RESPOSTA` e "portão offline".
9. `npm run sim:esp32 -- --mudo` e mande abrir: 504 com "o portão não respondeu a tempo".
