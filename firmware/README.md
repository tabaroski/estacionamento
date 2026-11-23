# Firmware do ESP32

Fica para a etapa final, depois da conferência da central do portão
(modelo da placa, bornes ABR e FEC, fotocélula).

Enquanto isso, o backend conversa com um ESP32 simulado que segue o mesmo
contrato: veja [`docs/contrato-mqtt.md`](../docs/contrato-mqtt.md) e
`backend/src/simulador/`. O firmware real só precisa cumprir esse contrato.

Planejado: PlatformIO, ESP32-WROOM-32, Wi-Fi 2,4 GHz, NTP, MQTT sobre TLS,
dois relés (ABR e FEC) e dois reed switches.
