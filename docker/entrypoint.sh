#!/bin/sh
# =============================================================================
# Punto de entrada del contenedor.
# =============================================================================
# Aplicar migraciones automáticamente al arrancar es cómodo en plataformas de
# un solo contenedor (Railway, Fly, Render), pero con varias réplicas provoca
# carreras. Por eso es opt-in mediante RUN_MIGRATIONS.
#
# El migrador toma un lock de aviso de MySQL, así que incluso con dos réplicas
# arrancando a la vez solo una aplica cambios; la otra espera y continúa.
# =============================================================================
set -eu

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "[entrypoint] Aplicando migraciones de base de datos…"
  node server/dist/db/migrate.js
  echo "[entrypoint] Migraciones al día."
fi

# `exec` reemplaza el shell por el proceso Node: así tini/SIGTERM llegan
# directamente a la aplicación y el apagado ordenado funciona.
exec "$@"
