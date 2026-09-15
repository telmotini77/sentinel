# Ejecución local

`api_zaSmaOlt` conserva el rol de API operativa original. `omniSentinel` es un
microservicio REST independiente: consume el feed privado de la API original;
no se conecta a Smart OLT, Zabbix ni a la misma capa de aplicación.

Los perfiles `*.env.local` son seguros para desarrollo: deshabilitan Telegram,
la exploración de Smart OLT y la entrega directa de alertas. No modifican los
archivos `.env` que puedan contener configuración operativa.

Desde esta carpeta ejecute:

```powershell
docker compose -f docker-compose.local.yml up --build
```

El navegador usa estas rutas, expuestas exclusivamente en loopback para no
publicar accidentalmente el entorno local:

| Servicio | URL |
| --- | --- |
| API operativa original | http://localhost:3100/health |
| Feed REST privado | http://localhost:3100/integration/v1/health |
| OmniSentinel | http://localhost:3101/ |
| Documentación REST de OmniSentinel | http://localhost:3101/api/docs |

OmniSentinel llama internamente a `http://api_zasmaolt:3010`; los navegadores
no deben utilizar ese nombre. Para probar el feed desde el host, use la clave
local definida en `api_zaSmaOlt/.env.local`:

```powershell
Invoke-RestMethod http://localhost:3100/integration/v1/health -Headers @{ 'x-api-key' = 'local-omnisentinel-service-key-2026' }
```

Para apagar los servicios conserve los datos con `docker compose -f
docker-compose.local.yml down`. Para eliminar también la base de desarrollo,
ejecute el mismo comando con `--volumes`.

Antes de conectar Smart OLT, Telegram o credenciales reales, cree un perfil
distinto de los archivos `*.env.local` y habilite explícitamente el scanner y
la entrega de alertas.
