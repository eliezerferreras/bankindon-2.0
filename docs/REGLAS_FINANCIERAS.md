# Reglas financieras acordadas para Bankindon

Este documento recoge decisiones del propietario del producto. No es una aprobación de tasas ni sustituye políticas contables o contractuales. Los ejemplos de prueba de aceptación se deben validar con el propietario antes de habilitar los cálculos.

## Moneda y caja

- La empresa configura una moneda única: DOP, USD o EUR. Todos los préstamos y movimientos se contabilizan en esa moneda.
- Hay una sola caja operativa.
- Banki separa el efectivo disponible, capital aportado, principal en cartera, principal recuperado, ingresos de intereses/mora cobrados, ingresos devengados pendientes y gastos registrados.
- El principal que vuelve no cuenta como ingreso. Ganancia neta cobrada = interés corriente cobrado + interés atrasado cobrado + mora cobrada − gastos registrados.
- Lo devengado y aún no cobrado se presenta aparte; al cobrarse se reclasifica sin duplicar ingreso.

## Préstamo tradicional

- Al originar, se generan todas las cuotas según modalidad y plazo.
- Antes del vencimiento de la primera cuota, se permite corregir los datos de origen. La edición debe conservar versiones y explicar cómo se recalcularán cuotas.
- Pago masivo admite elegir número de cuotas o introducir un importe; la vista previa muestra la distribución antes de confirmar. Pago total liquida el saldo.
- Orden de aplicación: mora, interés atrasado, interés corriente y capital.
- Los días de gracia se configuran en el préstamo. Si el atraso supera la gracia, el cálculo de interés atrasado cuenta desde el vencimiento, incluso durante los días de gracia concedidos.
- El interés atrasado se relaciona con capital pendiente de la cuota. Debe evitar capitalizar cargos o cobrar dos veces interés corriente.
- El cálculo diario tradicional conserva el capital vigente en cada fecha: un abono reduce el principal para los días siguientes y no reescribe intereses ya generados. El día del pago se devenga antes de registrar el abono; la reducción aplica desde el día siguiente. El importe diario se redondea a centavos.
- Durante una pausa se conserva lo ya devengado y no se generan cargos por los días pausados; al reanudar, el cálculo diario continúa y el contador de gracia conserva los días activos anteriores, incluso si el préstamo tuvo varias pausas.
- Solo se anula sin pagos y sin cuotas vencidas. Como la originación registra el desembolso, anular requiere confirmar que el capital se devolvió físicamente a la caja; el sistema registra esa entrada como recuperación de principal (no como ganancia), cierra las cuotas y conserva los valores anteriores en auditoría.
- Admin o supervisor pueden pausar cuando todas las cuotas estén vencidas para detener el crecimiento de la deuda. Al reanudar, conserva el saldo congelado y los cargos continúan desde la reactivación.
- Condonar interés atrasado o mora requiere autorización, motivo e historial inmutable.

## Interés periódico

- Los ciclos son mensuales y el día de vencimiento es fijo, por ejemplo, día 5.
- La cuota de interés se acumula a diario hasta el objetivo mensual. Para que el importe del ciclo sea igual aunque los meses tengan 28, 30 o 31 días, el objetivo se fija al inicio del ciclo y el devengo diario se prorratea por los días reales entre fechas de ciclo.
- En interés flotante, el objetivo del ciclo siguiente se basa en el capital pendiente al comienzo de ese ciclo. Un abono de capital durante el ciclo actual afecta el siguiente ciclo.
- Un pago completo anticipado cubre el objetivo íntegro del ciclo actual aunque parte del interés aún no se haya devengado por día. El saldo del ciclo no se vuelve a cobrar.
- Un pago parcial se asigna al ciclo actual; el devengo diario continúa solo sobre la parte restante del objetivo. El devengado acumulado del ciclo es el importe pagado por adelantado más el devengo proporcional de lo que falta, hasta completar el objetivo. La interfaz distingue objetivo, devengado, pagado y pendiente estimado.
- Los días de gracia se configuran por préstamo. Una cuota de interés pendiente genera mora después de la gracia, calculada diariamente sobre el importe de interés vencido con la tasa definida por el producto.

## Interés periódico de cuota fija

- El ciclo y calendario mensual usan las mismas reglas de acumulación diaria, anticipos y días de gracia que el interés periódico.
- Los pagos parciales al capital no reducen el objetivo de interés de los ciclos; este se mantiene sobre el capital original hasta que el préstamo queda totalmente liquidado.

## Libro, auditoría e importación

- Dinero recibido, distribución de pago, saldo del préstamo y movimiento de caja deben escribirse en una transacción MySQL indivisible.
- Los movimientos confirmados no se editan ni se borran. Una corrección crea un reverso vinculado y un movimiento nuevo, con actor, fecha, motivo y relación a la operación original.
- Pausas, reanudaciones, ediciones, condonaciones, anulaciones, pagos masivos y anticipos guardan quién los realizó, quién autorizó cuando corresponda, motivo y valores antes/después.
- La importación empieza en previsualización y conciliación: referencias rotas, duplicados, pagos que superan saldo, cuotas sin préstamo, saldos fuera de rango y cifras contradictorias se reportan antes de copiar a las tablas activas.

## Decisiones pendientes para activar cálculos

- Especificación numérica de cada modalidad tradicional (tasa nominal, método de amortización y regla exacta de mora).
- Tasa y convención diaria de mora periódica (la definición recibida indica aplicar la tasa del préstamo a la cuota de interés vencida; hay que convertir esa tasa a la unidad diaria sin ambigüedad).
- Política para pagos parciales sobre varios ciclos vencidos y el redondeo de centavos.
- Regla exacta de mora tradicional (base, periodicidad y redondeo). El interés atrasado ya se calcula por día con los abonos de capital y pausas aplicados por fecha, pero esta regla de mora sigue pendiente.
- Casos de aceptación con cifras concretas para cuota fija tradicional, pausa/reactivación, anticipos y condonaciones.
