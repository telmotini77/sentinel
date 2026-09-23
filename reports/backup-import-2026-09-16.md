# Importación de respaldos — 16 de septiembre de 2026

## Destino y resultado

Servidor: `10.101.2.11`. PostgreSQL activo: contenedor
`seiya-sentinel-postgres-1`, base `omniSentinel_db`.

| Destino | Resultado verificado |
| --- | --- |
| `zasmaolt.optical_history` | 10.746 lecturas históricas insertadas; total: 29.825 |
| `zasmaolt.naps` | 959 NAP actuales conservadas sin modificaciones del importador |
| `backup_archive.sources` | 7 fuentes registradas, con manifiestos SHA-256 de los 13 archivos originales |
| `backup_archive.records` | 47.150 registros preservados y cotejados campo por campo |
| Esquema `public` de OmniSentinel | Sin cambios por esta importación: la carpeta no contiene respaldos propios de OmniSentinel |

Ambas APIs respondieron correctamente después de la importación. OmniSentinel
reportó base de datos, RabbitMQ, API de mapas y almacenamiento disponibles.
Los dos contenedores permanecieron en ejecución, sin reinicios.

## Fuentes revisadas

Los cinco archivos SQLite pasaron `PRAGMA integrity_check`. Los dos JSON
pudieron analizarse correctamente. Se incluyeron los archivos WAL y SHM en
copias temporales antes de abrir SQLite en modo de solo lectura. Los hashes
originales no cambiaron durante la auditoría ni al finalizar el trabajo.

| Archivo lógico | NAP | Lecturas ópticas | Eventos de historial | Total de filas archivadas |
| --- | ---: | ---: | ---: | ---: |
| `nap_cache.json` | 570 | 0 | 0 | 570 |
| `status_history.json` | 0 | 0 | 0 | 0 |
| `telecom.db` (incluido WAL) | 583 | 10.746 | 0 | 11.331 |
| `telecom.test.db` (incluido WAL) | 19 | 621 | 459 | 1.254 |
| `telecom_backup_20260831.db` | 583 | 10.746 | 2 | 11.332 |
| `telecom_backup_20260831_verified.db` | 583 | 10.746 | 2 | 11.332 |
| `telecom_pre_postgres_20260915_093557.db` | 583 | 10.746 | 0 | 11.331 |

Los totales incluyen metadatos, secuencias SQLite, estado de alertas y colas
cuando esos registros están presentes. El archivo de pruebas contiene también
117 eventos de salida y 34 estados de alerta; se preservaron exclusivamente en
el archivo histórico. Sus credenciales y eventos no se activaron.

Los dos respaldos de agosto son idénticos. `telecom.db` y el respaldo previo a
PostgreSQL tienen el mismo archivo principal, pero el WAL de `telecom.db`
incorpora cambios de esquema, por lo que se auditaron por separado.

## Reglas de importación

- Las 42.984 apariciones de lecturas ópticas reales en cuatro respaldos se
  redujeron a 10.746 lecturas únicas. Los IDs SQLite no se reutilizaron.
- La comparación usa serial, instante de medición y valores ópticos. No se
  encontraron lecturas previas coincidentes ni valores contradictorios en el
  mismo instante. Se incorporaron las 10.746 lecturas faltantes.
- La segunda ejecución en modo de solo lectura encontró las 10.746 lecturas
  presentes y cero pendientes: repetir la importación no añade esas lecturas
  nuevamente.
- El archivo histórico conserva las copias de cada fuente con su procedencia;
  esas repeticiones no se copiaron a las tablas operativas.
- Los respaldos no identifican las cuentas SmartOLT de las NAP históricas.
  Contienen 583 nombres distintos, de los que 564 coinciden con el inventario
  actual. De 2.476 seriales históricos, 2.417 aparecen en el inventario actual.
  Los 19 nombres y 59 seriales restantes permanecen en el archivo histórico;
  no se inventaron cuentas, clientes activos ni ubicaciones actuales.
- Los dos eventos de los respaldos de agosto pertenecen a la prueba
  `NAP-ZABBIX-1`; no se incorporaron al historial operativo.
- No se reprodujeron eventos ni se cambiaron contraseñas, estados actuales,
  colas o configuraciones activas. No se ejecutaron migraciones de OmniSentinel.

## Respaldo previo y trazabilidad

Directorio privado del servidor:

```text
/var/backups/seiya-before-import-hdAzfbHv/
  omniSentinel_db-before-import.dump
  bundle.json
  import_legacy_backups.cjs
  import-report.json
```

El dump previo se generó con `pg_dump -Fc` y su índice fue leído correctamente
con `pg_restore --list`. No se hizo una restauración completa de prueba.

SHA-256 del paquete auditado, verificado tanto localmente como en el servidor:

```text
eb77548c4f8b7380118a02be662f7b0631af8ba8aa18945acaa277ad3fce866c
```

La importación se realizó en una transacción, con bloqueo de la tabla de
lecturas durante la comprobación final y la inserción. Se comprobó el contenido
completo de cada fila archivada antes de confirmar la transacción.

## Consulta del archivo histórico

Desde `/opt/seiya-sentinel` en el servidor:

```bash
sudo docker compose --env-file .env.server -f docker-compose.server.yml \
  exec postgres psql -U incident_user -d omniSentinel_db
```

Dentro de PostgreSQL:

```sql
SELECT file_name, is_test, row_counts
FROM backup_archive.sources
ORDER BY file_name;

SELECT s.file_name, r.table_name, count(*) AS records
FROM backup_archive.records r
JOIN backup_archive.sources s USING (source_key)
GROUP BY s.file_name, r.table_name
ORDER BY s.file_name, r.table_name;
```

El archivo contiene datos históricos de clientes y configuración; el esquema
no concede permisos a `PUBLIC`. No se añadió a las rutas públicas de las APIs.

## Herramientas del proyecto

- `scripts/audit_legacy_backups.py`: auditoría SQLite/JSON y paquete completo.
- `scripts/import_legacy_backups.cjs`: comparación de solo lectura por defecto;
  `--apply` activa archivo histórico e importación de lecturas faltantes.
- `scripts/import_legacy_backups.test.cjs`: cinco pruebas aprobadas que cubren
  deduplicación, conflictos, exclusión de pruebas, idempotencia y validación.
