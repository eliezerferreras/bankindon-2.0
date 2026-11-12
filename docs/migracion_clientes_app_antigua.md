# Migración de clientes desde la app antigua

- **Fecha:** 2026-11-11
- **Origen:** `bankindon/u269370433_bankindon01(1).sql` (volcado phpMyAdmin, MariaDB 11.8)
- **Destino:** base `bankindon` de la app nueva
- **Script:** `scripts/import-old-clients.mjs`
- **Ejecución:** `npm run clients:import-old -- --apply`

## Resultado

| Concepto | Cantidad |
| --- | ---: |
| Clientes en el volcado | 48 |
| Importados | 45 |
| Excluidos por documento duplicado | 3 |
| Duplicados dentro de la base nueva | 0 |

La importación se ejecutó en una transacción y dejó un evento `client.import` en
`audit_events`. El script es idempotente: si se vuelve a ejecutar, omite los
clientes que ya existen por tipo y número de documento.

## Clientes excluidos

Se excluyeron porque su documento ya estaba ocupado por otro cliente y los
números son claramente incompletos:

| Id antiguo | Nombre | Documento | Motivo |
| ---: | --- | --- | --- |
| 36 | JOSE MANUEL | DNI `66` | El id 35 (PAREDES) ya usa `DNI 66` |
| 40 | HÉCTOR MANUEL ENCARNACION MATEO | DNI `66` | El id 35 (PAREDES) ya usa `DNI 66` |
| 42 | PEDRO MAXIMO | DNI `666` | El id 38 (YEFRY ANYOLINA) ya usa `DNI 666` |

## Mapeo de campos

| App antigua (`clientes`) | App nueva (`clients`) |
| --- | --- |
| `nombre` | `first_name` |
| `apellidos` (o `apellido`) | `last_name` |
| `tipo_documento` | `document_type` |
| `identificacion` | `document_number` |
| `telefono` | `phone` |
| `nacionalidad` + tipo de documento | `country_code` |
| `email` | `email` |
| `direccion` | `address` |
| `fecha_nacimiento` | `birth_date` |
| `activo` | `status` |
| `fecha_registro` / `creado_en` | `created_at` |
| `garante_id` | `guarantor_client_id` (si el garante también es cliente) |

El país del documento se dedujo así: DNI/NIE/TIE → `ES`; Cédula → `DO`;
Pasaporte → país de la nacionalidad (DO/ES/US/OT).

## Ajustes de datos

- Se usó `SIN TELÉFONO` en 4 clientes sin teléfono.
- Se usó `SIN APELLIDO` en 2 clientes sin apellidos.
- Se guardaron vacías 2 fechas de nacimiento inválidas (`0000-00-00`).
- Se guardaron vacíos 2 correos inválidos (`senamas@hotmil`, `o@o`).
- Los espacios repetidos y los espacios al inicio/final se normalizaron.

## Datos que no se migraron

- **Fotos del documento:** los campos `foto_frontal` y `foto_posterior` del
  volcado contienen nombres de archivo, no las imágenes. No hay nada que
  trasladar a `client_documents`.
- **Calificación/scoring:** la app nueva no tiene esos campos en `clients`.
- **Garantes de texto libre:** `garante_nombre` no existe como cliente; en este
  volcado no había ninguno informado.
- **Nacionalidad:** no se guarda como campo independiente; solo se usó para
  deducir el país del documento.
