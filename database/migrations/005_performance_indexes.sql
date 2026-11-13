-- ============================================================================
-- 005 · Índices de rendimiento y robustez de auditoría
-- ============================================================================
-- Motivo: los informes y las búsquedas recorrían tablas completas. Estos
-- índices cubren los filtros reales que ejecuta la aplicación.
--
-- Nota: cada sentencia `ALTER TABLE` es atómica en MySQL 8 (DDL atómico). Si
-- una falla, esa sentencia no deja cambios, pero las anteriores del mismo
-- archivo ya están aplicadas. El migrador indica exactamente cuál falló; en
-- ese caso aplica a mano las sentencias restantes y vuelve a ejecutar
-- `npm run db:migrate`.
-- ============================================================================

-- Informes por rango de fechas: /api/reports/portfolio filtra por spent_at.
ALTER TABLE expenses
  ADD KEY idx_expenses_spent_at (spent_at);

-- Cobros y listados consultan cuotas por préstamo y estado.
ALTER TABLE installments
  ADD KEY idx_installment_loan_status (loan_id, status);

-- Informe de caja: filtra por tipo de movimiento dentro de un rango de fechas.
ALTER TABLE cash_movements
  ADD KEY idx_cash_type_date (movement_type, occurred_at);

-- El id de petición lo puede enviar el cliente (`x-request-id`); con CHAR(36)
-- un valor más largo provocaba el error 1406 al auditar y convertía un 401 en
-- un 500. Se amplía y se añade el índice del throttle de login.
ALTER TABLE audit_events
  MODIFY request_id VARCHAR(128) NULL,
  ADD KEY idx_audit_action_date (action, created_at);
