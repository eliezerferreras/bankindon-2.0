# Guía de Despliegue en Hostinger (Pre-producción)

Este paquete contiene la versión pre-compilada y lista para producción de **Bankindon 2.0**.

---

## Contenido del paquete

- `dist/web/`: Aplicación frontend compilada con Vite y React (HTML, CSS, JS optimizados).
- `server/dist/`: Servidor API compilado con Node.js y Fastify (sirve la API y los archivos estáticos en un solo puerto).
- `database/migrations/`: Migraciones SQL de la base de datos.
- `package.json` y `package-lock.json`: Dependencias de ejecución.
- `.env.example`: Plantilla de variables de entorno para producción.

---

## Pasos para instalar en Hostinger

### 1. Subir los archivos a Hostinger
1. Ve a **hPanel** en Hostinger -> **Administrador de Archivos** (File Manager).
2. Entra en la carpeta de tu dominio o subdominio de pruebas (por ejemplo `public_html` o la carpeta de tu aplicación Node.js).
3. Sube el archivo `bankindon-preprod.zip` y haz clic en **Extract** (Descomprimir).

---

### 2. Crear la Base de Datos MySQL en Hostinger
1. En hPanel, ve a **Bases de datos MySQL**.
2. Crea una base de datos nueva (ej. `u123456_bankindon_preprod`), un usuario y una contraseña segura.
3. Anota el nombre exacto de la base de datos, el usuario y la contraseña.

---

### 3. Configurar el archivo `.env`
1. En el Administrador de Archivos de Hostinger, renombra o copia `.env.example` como `.env`.
2. Edita el archivo `.env` con los datos de Hostinger:
   ```env
   NODE_ENV=production
   PORT=3000
   WEB_ORIGIN=https://tu-subdominio.tudominio.com
   APP_SECRET=genera_aqui_una_clave_aleatoria_de_al_menos_32_caracteres

   # Conexión a la base de datos de Hostinger
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=u123456_usuario_hostinger
   DB_PASSWORD=contraseña_creada_en_hostinger
   DB_NAME=u123456_bankindon_preprod

   # Credenciales para crear el usuario Administrador inicial
   BOOTSTRAP_ADMIN_NAME=Administrador
   BOOTSTRAP_ADMIN_EMAIL=admin@tudominio.com
   BOOTSTRAP_ADMIN_PASSWORD=ContraseñaSuperSegura2026!
   ```

---

### 4. Configurar la aplicación Node.js en Hostinger
1. En hPanel, busca la sección **Node.js** (o conéctate por **SSH** al servidor):
   - **Versión de Node.js:** Selecciona **Node.js 20.x** (o superior).
   - **Directorio raíz de la aplicación:** La carpeta donde descomprimiste los archivos.
   - **Archivo de inicio (Startup file):** `server/dist/index.js`
2. Si tienes acceso SSH o consola en hPanel, ejecuta:
   ```bash
   # Instalar dependencias de producción (sin herramientas de desarrollo pesadas)
   npm ci --omit=dev

   # Ejecutar las migraciones en la base de datos
   npm run db:migrate:prod

   # Crear el usuario administrador inicial (si es la primera vez)
   node server/dist/scripts/bootstrap-admin.js
   ```
3. Haz clic en **Start Application** (Iniciar aplicación) o reinicia la app en hPanel.

---

### 5. Probar el funcionamiento
1. Abre tu navegador e ingresa a la URL de tu subdominio o dominio en Hostinger.
2. Inicia sesión con el correo y contraseña del Administrador inicial.
3. ¡Listo! La aplicación cargará el nuevo panel, el cálculo de liquidación completa con interés flotante, el nuevo diseño de cuotas y la emisión de recibos.

