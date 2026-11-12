import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { config } from './config.js';

const key = new TextEncoder().encode(config.APP_SECRET);

export type UserRole = 'admin' | 'supervisor' | 'collector';
export type UserLanguage = 'es' | 'en' | 'fr';
export type UserTheme = 'dark' | 'light';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  language: UserLanguage;
  theme: UserTheme;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_SECONDS = config.SESSION_TTL_HOURS * 60 * 60;

/**
 * Opciones de la cookie de sesión, en un único lugar.
 *
 * `secure` se deriva de la configuración y no de `process.env.NODE_ENV`: antes
 * ambas fuentes podían discrepar y emitir cookies no seguras en producción.
 */
export function sessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function clearSessionCookieOptions(): CookieSerializeOptions {
  return { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/' };
}

export async function issueSession(user: SessionUser): Promise<string> {
  return new SignJWT({
    name: user.name,
    email: user.email,
    role: user.role,
    language: user.language,
    theme: user.theme,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('bankindon')
    .setAudience('bankindon-web')
    .setIssuedAt()
    .setExpirationTime(`${config.SESSION_TTL_HOURS}h`)
    .sign(key);
}

const ROLES: readonly UserRole[] = ['admin', 'supervisor', 'collector'];
const LANGUAGES: readonly UserLanguage[] = ['es', 'en', 'fr'];

function isRole(value: unknown): value is UserRole {
  return typeof value === 'string' && ROLES.includes(value as UserRole);
}

function isLanguage(value: unknown): value is UserLanguage {
  return typeof value === 'string' && LANGUAGES.includes(value as UserLanguage);
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    await reply.code(401).send({ error: 'Sesión requerida.' });
    return;
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: 'bankindon',
      audience: 'bankindon-web',
      algorithms: ['HS256'],
    });
    if (
      !payload.sub ||
      typeof payload.name !== 'string' ||
      typeof payload.email !== 'string' ||
      !isRole(payload.role)
    ) {
      throw new Error('invalid session');
    }
    request.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      language: isLanguage(payload.language) ? payload.language : 'es',
      theme: payload.theme === 'light' ? 'light' : 'dark',
    };
  } catch {
    reply.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
    await reply.code(401).send({ error: 'La sesión expiró. Inicia sesión nuevamente.' });
  }
}

export async function authorize(
  roles: UserRole[],
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'Sesión requerida.' });
    return;
  }
  if (!roles.includes(request.user.role)) {
    await reply.code(403).send({ error: 'No tienes permiso para esta operación.' });
  }
}
