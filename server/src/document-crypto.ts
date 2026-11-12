import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * Cifrado de documentos de identidad en reposo.
 *
 * Formato de sobre (sobre = "envelope"):
 *   v2: [0x02][nonce 12][authTag 16][ciphertext ...]
 *   v1: [nonce 12][authTag 16][ciphertext ...]        (formato heredado, sin marca)
 *
 * v1 derivaba la clave de APP_SECRET. v2 usa DOCUMENT_KEY (secreto distinto)
 * y añade una marca de versión que permite rotar la clave en el futuro sin
 * perder los documentos ya cifrados: los v1 siguen descifrándose con la clave
 * heredada y se re-cifran a v2 cuando se vuelvan a guardar.
 *
 * Rotación de clave (procedimiento recomendado):
 *   1. Desplegar con la nueva DOCUMENT_KEY manteniendo la anterior en
 *      DOCUMENT_KEY_PREVIOUS (pendiente de implementar si se necesita).
 *   2. Re-cifrar por lotes; los sobres v1 son identificables por su primer byte.
 */

const ENVELOPE_V2 = 0x02;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_V1_BYTES = NONCE_BYTES + TAG_BYTES;

function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), info, 'aes-256-gcm', 32));
}

const currentKey = deriveKey(config.DOCUMENT_KEY, 'bankindon-client-documents-v2');
/** Clave heredada: solo para leer sobres v1 ya existentes. */
const legacyKey = deriveKey(config.APP_SECRET, 'bankindon-client-documents-v1');

export function encryptDocument(plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', currentKey, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([ENVELOPE_V2]), nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptDocument(payload: Buffer): Buffer {
  if (payload.length > 0 && payload[0] === ENVELOPE_V2) {
    if (payload.length < 1 + HEADER_V1_BYTES) throw new Error('Documento cifrado incompleto.');
    const nonce = payload.subarray(1, 1 + NONCE_BYTES);
    const tag = payload.subarray(1 + NONCE_BYTES, 1 + HEADER_V1_BYTES);
    const encrypted = payload.subarray(1 + HEADER_V1_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', currentKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  // Sobre heredado (v1): sin marca de versión, clave derivada de APP_SECRET.
  if (payload.length < HEADER_V1_BYTES) throw new Error('Documento cifrado incompleto.');
  const nonce = payload.subarray(0, NONCE_BYTES);
  const tag = payload.subarray(NONCE_BYTES, HEADER_V1_BYTES);
  const encrypted = payload.subarray(HEADER_V1_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', legacyKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** Identifica un sobre heredado para poder re-cifrarlo por lotes. */
export function isLegacyEnvelope(payload: Buffer): boolean {
  return payload.length === 0 || payload[0] !== ENVELOPE_V2;
}

export function documentSha256(content: Buffer): Buffer {
  return createHash('sha256').update(content).digest();
}
