CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','supervisor','collector') NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  preferred_language ENUM('es','en','fr') NOT NULL DEFAULT 'es',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS company_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  company_name VARCHAR(160) NOT NULL DEFAULT 'Bankindon',
  currency CHAR(3) NOT NULL DEFAULT 'DOP',
  locale ENUM('es','en','fr') NOT NULL DEFAULT 'es',
  timezone VARCHAR(80) NOT NULL DEFAULT 'America/Santo_Domingo',
  grace_days_default SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_company_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  document_type VARCHAR(40) NOT NULL,
  document_number VARCHAR(60) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  email VARCHAR(190) NULL,
  address VARCHAR(500) NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_document (document_type, document_number),
  KEY idx_client_name (last_name, first_name),
  CONSTRAINT fk_client_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  product ENUM('traditional','periodic_interest','fixed_periodic_interest') NOT NULL,
  principal DECIMAL(16,2) NOT NULL,
  principal_outstanding DECIMAL(16,2) NOT NULL,
  interest_rate DECIMAL(8,5) NOT NULL,
  interest_period ENUM('day','week','fortnight','month') NOT NULL DEFAULT 'month',
  installment_count SMALLINT UNSIGNED NULL,
  installment_frequency ENUM('day','week','fortnight','month') NULL,
  due_day TINYINT UNSIGNED NULL,
  grace_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  late_interest_rate DECIMAL(8,5) NOT NULL DEFAULT 0,
  notes VARCHAR(1000) NULL,
  status ENUM('draft','active','paused','paid','cancelled') NOT NULL DEFAULT 'draft',
  paused_at DATE NULL,
  paused_days INT UNSIGNED NOT NULL DEFAULT 0,
  first_due_date DATE NOT NULL,
  currency CHAR(3) NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_loans_client_status (client_id, status),
  KEY idx_loans_due_status (status, first_due_date),
  CONSTRAINT chk_loan_principal CHECK (principal > 0 AND principal_outstanding >= 0),
  CONSTRAINT chk_loan_rate CHECK (interest_rate >= 0 AND late_interest_rate >= 0),
  CONSTRAINT chk_loan_currency CHECK (currency IN ('DOP','USD','EUR')),
  CONSTRAINT fk_loan_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_loan_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_loan_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS installments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  loan_id BIGINT UNSIGNED NOT NULL,
  installment_number INT UNSIGNED NOT NULL,
  period_start DATE NOT NULL,
  due_date DATE NOT NULL,
  principal_due DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_target DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_accrued DECIMAL(16,2) NOT NULL DEFAULT 0,
  interest_paid DECIMAL(16,2) NOT NULL DEFAULT 0,
  late_interest_accrued DECIMAL(16,2) NOT NULL DEFAULT 0,
  penalty_accrued DECIMAL(16,2) NOT NULL DEFAULT 0,
  principal_paid DECIMAL(16,2) NOT NULL DEFAULT 0,
  status ENUM('scheduled','open','due','overdue','paid','waived') NOT NULL DEFAULT 'scheduled',
  closed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_loan_installment (loan_id, installment_number),
  UNIQUE KEY uq_loan_due_date (loan_id, due_date),
  KEY idx_installment_due_status (due_date, status),
  CONSTRAINT chk_installment_amounts CHECK (principal_due >= 0 AND interest_target >= 0 AND interest_accrued >= 0),
  CONSTRAINT fk_installment_loan FOREIGN KEY (loan_id) REFERENCES loans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  loan_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  paid_at DATETIME NOT NULL,
  payment_method ENUM('cash','bank_transfer','card','check','other') NOT NULL DEFAULT 'cash',
  reference VARCHAR(120) NULL,
  kind ENUM('regular','advance','bulk','payoff') NOT NULL DEFAULT 'regular',
  status ENUM('posted','reversed') NOT NULL DEFAULT 'posted',
  idempotency_key CHAR(36) NOT NULL UNIQUE,
  received_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_payments_loan_date (loan_id, paid_at),
  CONSTRAINT chk_payment_amount CHECK (amount > 0),
  CONSTRAINT fk_payment_loan FOREIGN KEY (loan_id) REFERENCES loans(id),
  CONSTRAINT fk_payment_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_payment_receiver FOREIGN KEY (received_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_allocations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT UNSIGNED NOT NULL,
  installment_id BIGINT UNSIGNED NULL,
  component ENUM('penalty','late_interest','current_interest','principal') NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_allocation_installment (installment_id, component),
  CONSTRAINT chk_allocation_amount CHECK (amount > 0),
  CONSTRAINT fk_allocation_payment FOREIGN KEY (payment_id) REFERENCES payments(id),
  CONSTRAINT fk_allocation_installment FOREIGN KEY (installment_id) REFERENCES installments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_movements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  movement_type ENUM('capital_injection','loan_disbursement','payment_received','expense','owner_withdrawal','payment_reversal','loan_cancellation','adjustment') NOT NULL,
  direction ENUM('in','out') NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  capital_component DECIMAL(16,2) NOT NULL DEFAULT 0,
  current_interest_component DECIMAL(16,2) NOT NULL DEFAULT 0,
  late_interest_component DECIMAL(16,2) NOT NULL DEFAULT 0,
  penalty_component DECIMAL(16,2) NOT NULL DEFAULT 0,
  reference_type VARCHAR(40) NULL,
  reference_id BIGINT UNSIGNED NULL,
  description VARCHAR(500) NOT NULL,
  occurred_at DATETIME NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  reversal_of BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cash_date (occurred_at),
  KEY idx_cash_reference (reference_type, reference_id),
  CONSTRAINT chk_cash_amount CHECK (amount > 0),
  CONSTRAINT fk_cash_user FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT fk_cash_reversal FOREIGN KEY (reversal_of) REFERENCES cash_movements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL,
  amount DECIMAL(16,2) NOT NULL,
  spent_at DATETIME NOT NULL,
  recorded_by BIGINT UNSIGNED NOT NULL,
  cash_movement_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_expense_amount CHECK (amount > 0),
  CONSTRAINT fk_expense_user FOREIGN KEY (recorded_by) REFERENCES users(id),
  CONSTRAINT fk_expense_movement FOREIGN KEY (cash_movement_id) REFERENCES cash_movements(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loan_adjustments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  loan_id BIGINT UNSIGNED NOT NULL,
  installment_id BIGINT UNSIGNED NULL,
  action ENUM('pause','resume','waive','edit','cancel','reverse') NOT NULL,
  reason VARCHAR(500) NOT NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_adjustment_loan_date (loan_id, created_at),
  CONSTRAINT fk_adjustment_loan FOREIGN KEY (loan_id) REFERENCES loans(id),
  CONSTRAINT fk_adjustment_installment FOREIGN KEY (installment_id) REFERENCES installments(id),
  CONSTRAINT fk_adjustment_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_adjustment_approver FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  request_id CHAR(36) NULL,
  before_data JSON NULL,
  after_data JSON NULL,
  ip_address VARBINARY(16) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity_type, entity_id, created_at),
  KEY idx_audit_actor (actor_id, created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO company_settings (id, company_name, currency, locale, timezone) VALUES (1,'Bankindon','DOP','es','America/Santo_Domingo');
