# Revisión funcional de la aplicación anterior

La copia anterior se revisó en modo lectura. Sus archivos SQL pueden contener datos personales; por eso la carpeta `bankindon/` está excluida del control de versiones del proyecto nuevo.

## Funciones localizadas

- `src/Controllers/BankiController.php` y `src/Models/BankiModel.php`: centro Banki, aportes, retiros, préstamos otorgados, pagos recibidos y consultas de saldos.
- `src/Models/PrestamoModel.php`: creación de cuotas tradicionales, simulación y cálculo de mora/interés atrasado.
- `src/Models/AbonoModel.php` y `public/abonos/pago_masivo.php`: asignación de pagos y pago de cuotas en lote.
- `src/Models/CondonacionModel.php`: condonación de cargos y registro de motivo/usuario.
- `public/prestamos/ver_interes_periodico.php` y las pantallas de pago periódico: ciclos, cuotas de interés, mora y pagos.

## Hallazgos que requieren reconstrucción, no copia literal

1. **Interés tradicional:** `PrestamoModel::calcularSimulacionPrestamo` usa capital dividido en partes iguales y un interés simple calculado sobre el capital inicial. No es amortización francesa. La tasa parece tratarse como una tasa mensual y prorratearse por 2 para quincenal o 4 para semanal; la rama diaria tiene otra fórmula. Esta diferencia debe quedar explícita por producto y período.
2. **Interés de la primera cuota:** el cálculo de día fijo agrega una cuota inicial prorrateada y luego avanza el calendario con otra secuencia de fechas. Deben probarse los límites de mes, inicio en el propio día de pago y meses cortos para evitar fechas duplicadas o saltadas.
3. **Interés atrasado y gracia:** la función `calcularMoraEInteresAtrasado` mide los días desde el final de la gracia, y no desde el vencimiento. Esto contradice la regla explicada para el sistema nuevo: al exceder la gracia, calcular retroactivamente desde el vencimiento. También calcula la mora como porcentaje del interés atrasado, por lo que ese comportamiento debe revisarse contra la política deseada.
4. **Varias implementaciones:** `CuotaModel::calcularYActualizarInteresAtrasado` mantiene otro cálculo y otro prorrateo. Ambos modelos pueden actualizar cuotas con resultados diferentes.
5. **Interés periódico:** en `ver_interes_periodico.php`, la nueva cuota usa `capital_inicial × tasa mensual`, aun cuando existe capital actual. Eso no satisface el interés flotante descrito por el propietario. En distintos flujos la mora usa conversiones diarias distintas y aparece incluso una tasa fija codificada.
6. **Banki:** el modelo calcula desde `transacciones`, extrae componentes de pagos desde JSON almacenado en texto y actualiza a la vez `control_caja` directamente en otros flujos. Una sola operación puede quedar representada de dos formas o producir saldos divergentes.
7. **Reversos y edición:** varios flujos antiguos permiten ajustar caja, borrar movimientos relacionados o actualizar saldos directamente. El sistema nuevo debe conservar los eventos originales y añadir reversos enlazados.

## Consecuencia para la reconstrucción

El sistema nuevo debe tener una sola implementación de cada cálculo y una sola vía para registrar dinero. Para aceptar una fórmula se documentará su unidad de tasa, base, período, días de gracia, orden de aplicación, redondeo y fecha efectiva; se comparará con casos esperados antes de permitir que registre movimientos reales.
