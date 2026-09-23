# Política de alertas NAP y puerto PON

Solicitud confirmada: alertar del 80% al 100% tanto para energía como para pérdida de señal.

## Reglas

- NAP: al menos 80% de todas sus ONUs deben reportar la misma causa explícita (Power Fail/Dying Gasp o LOS/corte de fibra).
- Menos de 80% no genera alerta automática a Telegram.
- Estados desconocidos, Offline sin causa y ONUs ausentes de una respuesta parcial no se convierten en una causa ni se excluyen para inflar el porcentaje.
- Una ONU Online no cuenta como afectada aunque conserve una razón histórica de caída.
- Puerto: todas sus NAPs deben cumplir el umbral por la misma causa. Una NAP por debajo del umbral, ausente o con otra causa impide la consolidación del puerto; las NAPs que sí califican pueden alertar por separado.
- “Total” se utiliza solo al 100%. Del 80% a menos del 100% se informa afectación parcial y el porcentaje real.
- Los porcentajes enviados proceden de la misma consulta usada para validar la alerta, no de estados antiguos del mapa.
- Agrupar NAPs de una OLT no demuestra la caída de un puerto; el título distingue ambos casos.
- Se mantienen los recordatorios existentes cada tres horas y el límite de nueve horas mientras persista el incidente. La minoría Online no reinicia el aviso.

## Pruebas

Diez suites ejecutadas correctamente en una base temporal separada, con las llamadas de Telegram y SmartOLT simuladas:

1. `test_nap_alert_policy.ts`: 20%, 50%, 79%, 80%, 99%, 100%; causas mixtas; inventario incompleto; caché antigua; NAP/puerto; radar y duplicados.
2. `test_smartolt_alert_types.ts`.
3. `test_port_alert_filter.ts`.
4. `test_olt_incident_grouping.ts`: incluye recuperación antes del envío diferido.
5. `test_scanner_port_power_grouping.ts`.
6. `test_nap_loss_scanner.ts`: incluye recordatorios y límite temporal.
7. `test_zabbix_nap_loss.ts`.
8. `test_parser.ts`.
9. `test_smartolt_multi_domain.ts`.
10. `test_telegram_multi_chat.ts`.

No se enviaron mensajes de prueba a los grupos reales. La compilación local de servidor, recursos estáticos y cliente se completó correctamente.

## Respaldo y despliegue

Servidor: `10.101.2.11`, proyecto `/opt/seiya-sentinel/api_zaSmaOlt`.

Respaldo previo: `/var/backups/seiya-alert-policy-qAFRSqut/`.

- `database-before.dump`: respaldo completo de la base activa; catálogo del archivo validado con `pg_restore --list`.
- `source-before.tgz`: código previo.
- `sentinel-alert-policy-patch.tar`: archivos modificados.
- `tests-final.log`: resultado de las pruebas.
- Imagen anterior conservada como `seiya-alert-policy-rollback:20260917`.

Estado: compilación de la imagen del servidor en curso; pendiente reinicio exclusivo de la API y comprobación de salud.
