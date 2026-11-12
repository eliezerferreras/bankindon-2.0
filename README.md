# Bankindon

Bankindon es una aplicación financiera propia, construida con React, TypeScript, Vite, Fastify y MySQL. El cliente web no guarda datos de negocio en el navegador: obtiene la información de la API y MySQL es la fuente persistente.

## Desarrollo local

1. Usa Node.js 20 o superior y MySQL 8/MariaDB compatible con InnoDB.
2. Crea una base de datos vacía y configura `.env` a partir de `.env.example`.
3. Define `APP_SECRET` con al menos 32 caracteres aleatorios y las credenciales MySQL.
4. Ejecuta `npm install` y `npm run db:migrate`.
5. Crea el primer usuario con `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL` y `BOOTSTRAP_ADMIN_PASSWORD` (12 caracteres mínimo) usando `npm run db:bootstrap-admin`.
6. Inicia web y API con `npm run dev`; abre `http://localhost:5173`.
7. Compila la web y la API con `npm run build`.

## Alcance en construcción

- Inicio con indicadores de cartera y caja, actividad reciente y accesos directos.
- Clientes, perfiles, garantes, garantías, documentos de identidad cifrados en MySQL e importación CSV con previsualización.
- Préstamos tradicionales y periódicos, simulación, detalle de cuotas, pagos con vista previa y reglas de devengo diario.
- Edición auditada de préstamos tradicionales antes del primer vencimiento y sin pagos; anulación auditada solo sin pagos ni cuotas vencidas y con confirmación de devolución del capital a caja.
- Centro Banki para caja única, aportes, gastos, ingresos cobrados y devengados pendientes; informes agregados por rango y exportación completa de cartera en CSV.
- Roles de administrador, supervisor y cobrador; preferencias personales de tema e idioma (español, inglés y francés).
- Moneda única de empresa: DOP, USD o EUR.

## Reglas y seguridad

Las operaciones de pago se registran en transacciones MySQL y con distribución por concepto. Las imágenes se cifran antes de guardarse; el acceso queda restringido a administrador y supervisor y se audita. Las reglas de los productos y los casos que aún requieren cerrar decisiones están en [`docs/REGLAS_FINANCIERAS.md`](docs/REGLAS_FINANCIERAS.md).

Esta aplicación sigue en desarrollo. Antes de usarla con dinero real deben terminarse los flujos pendientes de cartera, conciliación e informes, y validarse las reglas financieras con casos de aceptación acordados. No uses datos reales en pruebas ni compartas `.env`, claves o fotos de clientes.
