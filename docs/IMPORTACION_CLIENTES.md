# Importar clientes desde Bankindon antiguo

La nueva aplicación permite importar perfiles básicos mediante CSV y no escribe en la base de datos antigua. La importación requiere rol de administrador o supervisor y se ejecuta desde **Clientes → Importar clientes**.

## Preparar el CSV

En phpMyAdmin, selecciona la base antigua y la tabla `clientes`. Usa **Exportar → Personalizado → CSV**, con codificación UTF-8. Exporta estas columnas:

- Obligatorias: `nombre`, `apellidos` (también se reconoce `apellido`), `tipo_documento`, `identificacion`, `telefono`.
- Opcionales: `email`, `direccion`, `activo`, `pais_documento` (DO, ES, US u OT). Si no se especifica, el país del documento queda como OT (otro país).

No exportes fotos, datos de garantes ni columnas ajenas al perfil básico. La importación no copia fotos, garantías, calificación/scoring, préstamos ni pagos. Corrige antes del proceso los clientes sin apellido, tipo/identificación, o teléfono; esas filas se reportarán como inválidas.

## Vista previa y guardado

1. En la nueva app abre **Clientes → Importar clientes** y selecciona el CSV.
2. Pulsa **Validar archivo**. La vista previa cuenta las filas listas, duplicadas e inválidas.
3. Revisa la muestra de filas y pulsa **Importar clientes válidos**. Las filas duplicadas o inválidas se omiten. Puedes importar hasta 500 filas por archivo; divide los CSV más grandes.

Un documento que ya existe en la base nueva o que aparece repetido en el mismo CSV no se vuelve a insertar. La importación no crea préstamos ni movimientos de Banki. El servidor guarda los registros nuevos y un evento de auditoría en MySQL dentro de una transacción.

## Mapeo

`nombre → first_name`, `apellidos/apellido → last_name`, `tipo_documento → document_type`, `identificacion → document_number`, `telefono → phone`, `pais_documento → country_code`, `email → email`, `direccion → address`. `activo=0`, `inactivo`, `inactive`, `false` o `no` se importan como inactivos; los demás valores quedan activos.
