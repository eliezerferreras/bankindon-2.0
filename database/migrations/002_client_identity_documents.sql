ALTER TABLE clients
  ADD COLUMN country_code CHAR(2) NOT NULL DEFAULT 'DO' AFTER phone;

CREATE TABLE IF NOT EXISTS client_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  side ENUM('front','back') NOT NULL,
  mime_type ENUM('image/jpeg','image/png','image/webp') NOT NULL,
  original_name VARCHAR(160) NOT NULL,
  file_size INT UNSIGNED NOT NULL,
  sha256 BINARY(32) NOT NULL,
  encrypted_content MEDIUMBLOB NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_client_document_side (client_id,side),
  KEY idx_client_document_client (client_id,created_at),
  CONSTRAINT chk_client_document_size CHECK (file_size BETWEEN 1 AND 5242880),
  CONSTRAINT fk_client_document_client FOREIGN KEY (client_id) REFERENCES clients(id),
  CONSTRAINT fk_client_document_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
