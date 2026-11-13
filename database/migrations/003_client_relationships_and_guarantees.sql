ALTER TABLE clients
  ADD COLUMN birth_date DATE NULL AFTER address,
  ADD COLUMN guarantor_client_id BIGINT UNSIGNED NULL AFTER birth_date,
  ADD KEY idx_client_guarantor (guarantor_client_id),
  ADD CONSTRAINT fk_client_guarantor FOREIGN KEY (guarantor_client_id) REFERENCES clients(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS client_guarantees (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  loan_id BIGINT UNSIGNED NULL,
  guarantee_type VARCHAR(80) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  estimated_value DECIMAL(16,2) NULL,
  status ENUM('active','in_process','released','executed') NOT NULL DEFAULT 'active',
  notes VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_client_guarantee_client (client_id,status),
  KEY idx_client_guarantee_loan (loan_id),
  CONSTRAINT chk_client_guarantee_value CHECK (estimated_value IS NULL OR estimated_value >= 0),
  CONSTRAINT fk_client_guarantee_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_client_guarantee_loan FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL,
  CONSTRAINT fk_client_guarantee_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
