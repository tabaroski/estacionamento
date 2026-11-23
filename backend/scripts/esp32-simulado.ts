/**
 * ESP32 simulado para testar sem a placa.
 *
 *   npm run sim:esp32                      portão normal (6 s de curso)
 *   npm run sim:esp32 -- --fecha-sozinho 15  fecha sozinho 15 s depois de abrir
 *   npm run sim:esp32 -- --atraso-ms 7000  rede lenta: comandos chegam vencidos (EXPIRADO)
 *   npm run sim:esp32 -- --mudo            placa travada: backend registra SEM_RESPOSTA
 *
 * Ctrl+C desliga avisando "offline".
 */
import { parseArgs } from 'node:util';
import { Esp32Simulado } from '../src/simulador/esp32-simulado.js';

try {
  process.loadEnvFile();
} catch {
  // sem .env: usa padrões
}

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.MQTT_URL ?? 'mqtt://localhost:1883' },
    portao: { type: 'string', default: process.env.PORTAO_ID ?? 'principal' },
    'curso-s': { type: 'string', default: '6' },
    'atraso-ms': { type: 'string', default: '0' },
    'fecha-sozinho': { type: 'string', default: '0' },
    mudo: { type: 'boolean', default: false },
    aberto: { type: 'boolean', default: false },
  },
});

const hora = () => new Date().toLocaleTimeString('pt-BR');

const sim = new Esp32Simulado({
  url: values.url,
  portaoId: values.portao,
  usuario: process.env.MQTT_USUARIO,
  senha: process.env.MQTT_SENHA,
  estadoInicial: values.aberto ? 'ABERTO' : 'FECHADO',
  tempoCursoMs: Number(values['curso-s']) * 1000,
  atrasoMs: Number(values['atraso-ms']),
  fecharSozinhoMs: Number(values['fecha-sozinho']) * 1000,
  mudo: values.mudo,
  registrar: (linha) => console.log(`[${hora()}] ${linha}`),
});

await sim.iniciar();
console.log(`ESP32 simulado no broker ${values.url}, portão "${values.portao}". Ctrl+C para desligar.`);

process.on('SIGINT', async () => {
  await sim.parar();
  console.log('Desligado (status offline enviado).');
  process.exit(0);
});
