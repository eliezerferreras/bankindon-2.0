# Clientes y documentos de identidad

El país seleccionado en la ficha se refiere al país emisor del documento, no necesariamente a la nacionalidad o residencia del cliente. El catálogo inicial ofrece:

- **República Dominicana:** cédula dominicana, pasaporte y licencia de conducir.
- **España:** DNI, NIE, TIE/tarjeta de residencia, pasaporte y permiso de conducir.
- **Estados Unidos:** identificación estatal, licencia de conducir, tarjeta de residente permanente, autorización de empleo y pasaporte.
- **Otro país:** documento nacional, pasaporte, permiso de residencia, licencia de conducir u otro documento.

Los números se guardan como texto para conservar letras, ceros iniciales y formatos distintos. El formulario no asume que un número de DNI, NIE o identificación estatal tenga el mismo patrón internacional.

## Fotos

En el alta se pueden adjuntar frente y reverso. Se aceptan JPEG, PNG y WebP de hasta 5 MB por imagen. Los bytes se cifran con AES-256-GCM y se guardan en MySQL; la app no crea copias persistentes en el navegador ni en el disco del servidor. El servidor comprueba el tipo real de imagen, registra quién la cargó y audita cada consulta. Las respuestas de imagen usan `Cache-Control: no-store`.

Solo administradores y supervisores pueden consultar las imágenes. Los cobradores pueden registrar clientes y cargar sus fotos, pero no consultar las fotos desde la ficha de clientes.

La clave criptográfica se deriva de `APP_SECRET` en `.env`. Mantén ese secreto respaldado y estable: si se pierde o cambia, las fotos ya guardadas no se podrán descifrar. La rotación requiere un procedimiento de recifrado antes de cambiar la clave.

Las imágenes son documentos proporcionados por el usuario; la app conserva el archivo y el tipo elegido, pero no verifica autenticidad ni vigencia legal.
