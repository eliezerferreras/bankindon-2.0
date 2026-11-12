# Plan de optimización · Bankindon 2.0

Documento de trabajo que acompaña a los cambios aplicados. Ordena el trabajo en
tres fases: correcciones críticas, automatización base y escala.

---

## 1. Diagnóstico

Aplicación: React 19 + Vite 6 (SPA) · Fastify 5 + TypeScript (API) · MySQL 8.
Estado de partida: `tsc` sin errores, 5 pruebas unitarias de cálculo financiero,
sin repositorio Git, sin contenedores y sin CI.

### Hallazgos críticos (corregidos)

| # | Hallazgo | Impacto | Estado |
|---|----------|---------|--------|
| 1 | El devengo bloqueaba **toda** la cartera (`FOR UPDATE` sobre `loans`) y se ejecutaba en cada cobro | El coste de un cobro crecía con el tamaño de la cartera; un préstamo con datos raros abortaba el ciclo de todos | Corregido |
| 2 | El devengo corría con `setInterval` por proceso, sin lock | Con dos instancias, devengos duplicados y deadlocks | Corregido |
| 3 | `APP_SECRET` cifraba los documentos **y** firmaba las sesiones | Rotar el secreto de sesión dejaba ilegibles todos los documentos de identidad | Corregido |
| 4 | Login sin límite por cuenta ni registro de fallos | Fuerza bruta distribuida invisible | Corregido |
| 5 | El manejador de errores convertía todo en 500 | Un 429/413 se reportaba como error del servidor; el cliente no podía reintentar bien | Corregido |
| 6 | `trustProxy` desactivado | Detrás de un proxy, `request.ip` es la del proxy: auditoría falsa y rate limit compartido | Corregido |
| 7 | El migrador dividía SQL con `sql.split(';')` y no tenía lock | Migraciones truncadas o aplicadas dos veces | Corregido |
| 8 | `audit_events.request_id` era `CHAR(36)` | Un `x-request-id` más largo producía error 1406 al auditar | Corregido |
| 9 | La cookie usaba `process.env.NODE_ENV` en vez de la configuración validada | Posible cookie sin `Secure` en producción | Corregido |
| 10 | No había health checks separados | Un fallo de BD reiniciaba contenedores sanos | Corregido |

### Hallazgos pendientes (por prioridad)

- **Búsquedas con `LIKE '%texto%'`** sobre `CONCAT(...)` en clientes y préstamos:
  no pueden usar índice y se ejecutan en cada pulsación. Requiere columna
  normalizada + índice `FULLTEXT` (ver fase 3).
- **`route.ts` (87 KB) y `App.tsx` (104 KB)** monolíticos: impiden code splitting
  real y hacen costoso cualquier cambio.
- **Subconsultas correlacionadas** por fila en el listado de préstamos.
- **Sin revocación de sesión**: un logout no invalida el JWT en otros dispositivos.
- **`react-router-dom` instalado y no usado**; la navegación es estado propio.
- **Sin repositorio Git**: bloquea CI/CD, revisión de cambios y despliegue seguro.

---

## 2. Cambios aplicados

### Fase 1 · Correcciones críticas

- `server/src/config.ts`: configuración validada una sola vez, con mensajes
  legibles; nuevas variables (`DOCUMENT_KEY`, `SESSION_TTL_HOURS`,
  `COOKIE_SECURE`, `TRUST_PROXY`, `ACCRUAL_*`, `LOGIN_*`, `RATE_LIMIT_*`).
- `server/src/document-crypto.ts`: sobre versionado (`v1` heredado / `v2` con
  `DOCUMENT_KEY`). Los documentos existentes siguen descifrándose.
- `server/src/accrual.ts`: devengo por préstamo en su propia transacción, lock de
  aviso para el barrido, aislamiento de fallos y escritura solo si el valor
  cambia. Nuevas entradas: `runAccrualCycleForLoan` y `runAccrualCycle`.
- `server/src/auth.ts`: opciones de cookie centralizadas, `iss`/`aud` en el JWT.
- `server/src/index.ts`: `trustProxy`, errores con su código real, CSP, validación
  de `Origin` en métodos que mutan estado, `/api/health/live` y `/ready`,
  apagado ordenado con plazo máximo.
- `server/src/login-throttle.ts` + migración `006`: bloqueo temporal por cuenta y
  auditoría de accesos fallidos.
- `server/src/db/migrate.ts` + `sql-splitter.ts` + migración `005`.

### Fase 2 · Automatización base

- `Dockerfile` multi-stage, usuario sin privilegios, `tini` como PID 1.
- `docker-compose.yml` con MySQL, salud, migración previa y red interna.
- `.github/workflows/ci.yml`: tipos, pruebas, build, integración con MySQL real,
  auditoría de dependencias y build de la imagen.
- `tests/smoke/api-smoke.mjs`: humo contra el API desplegado.

### Fase 3 · Escala (siguiente)

1. Búsqueda: columna generada `search_text` + `FULLTEXT` y consulta con
   `MATCH ... AGAINST` en modo booleano.
2. Trocear `App.tsx` por pantalla con `React.lazy` y rutas reales.
3. Trocear `routes.ts` por dominio (`loans`, `clients`, `cash`, `reports`).
4. Sustituir las subconsultas del listado por una vista agregada o un `JOIN`
   con `GROUP BY`.
5. Revocación de sesión: tabla `sessions` con `jti` y comprobación opcional.
6. Copias de seguridad verificadas y restauración probada.

---

## 3. Criterios de aceptación

- `npm run typecheck` y `npm test` en verde.
- `npm run db:migrate` ejecutado dos veces seguidas sin errores.
- `npm run test:smoke` en verde contra el entorno desplegado.
- Métrica objetivo: tiempo de cobro constante e independiente del número de
  préstamos (antes crecía linealmente).
