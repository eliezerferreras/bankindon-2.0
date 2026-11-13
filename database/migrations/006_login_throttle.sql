-- ============================================================================
-- 006 · Throttle de intentos de acceso
-- ============================================================================
-- Antes, el único freno al ataque de fuerza bruta era el límite global de
-- 120 peticiones/minuto, y los intentos fallidos no se registraban en ningún
-- sitio: no había forma de detectar un ataque en curso.
--
-- Se guarda un hash del correo (no el correo) porque esta tabla es de alta
-- rotación y no necesita datos personales para funcionar.
-- ============================================================================

CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email_hash CHAR(64) NOT NULL,
  ip_hash CHAR(64) NULL,
  succeeded TINYINT(1) NOT NULL DEFAULT 0,
  attempted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- El conteo del throttle es (email_hash, ventana temporal).
  KEY idx_login_attempt_email (email_hash, attempted_at),
  KEY idx_login_attempt_date (attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
