/**
 * Cliente HTTP del frontend.
 *
 * Antes, cualquier fallo de red o un servidor lento dejaba la interfaz
 * colgada indefinidamente: no había tiempo máximo, ni reintentos, ni forma de
 * detectar globalmente que la sesión había caducado (cada pantalla mostraba su
 * propio error).
 *
 * Aquí se centraliza:
 *  - tiempo máximo por petición (AbortController);
 *  - reintentos con espera exponencial y jitter SOLO en peticiones seguras
 *    (GET/HEAD) o cuando hay clave de idempotencia;
 *  - aviso global de sesión caducada (401);
 *  - errores tipados que distinguen «reintentable» de «definitivo».
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 500,
    /** true si tiene sentido que el usuario reintente la operación. */
    public retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class TimeoutError extends ApiError {
  constructor(timeoutMs: number) {
    super(`La operación tardó demasiado (${Math.round(timeoutMs / 1000)} s). Revisa tu conexión.`, 0, true);
    this.name = 'TimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** Las subidas de documentos necesitan más margen. */
const UPLOAD_TIMEOUT_MS = 90_000;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

export interface ApiOptions {
  timeoutMs?: number;
  /** Reintentos extra permitidos (por defecto 2 en peticiones seguras). */
  retries?: number;
  signal?: AbortSignal;
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Registra qué hacer cuando el servidor responde 401 (sesión caducada).
 * Devuelve una función para desregistrarlo.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera exponencial con jitter: evita que muchos clientes reintenten a la vez. */
function backoffDelay(attempt: number): number {
  const base = 300 * 2 ** attempt;
  return base + Math.random() * 200;
}

function combineSignals(controller: AbortController, external?: AbortSignal): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    controller.abort(external.reason);
    return () => undefined;
  }
  const onAbort = () => controller.abort(external.reason);
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

async function attempt<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const detach = combineSignals(controller, external);
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);

  try {
    const response = await fetch(path, { ...init, signal: controller.signal });
    const body = await readJson(response);

    if (!response.ok) {
      const message =
        typeof body.error === 'string' ? body.error : 'No se pudo completar la solicitud.';
      const retryable = RETRYABLE_STATUS.has(response.status);

      // Sesión caducada: avisar una sola vez a la aplicación.
      if (response.status === 401 && !path.startsWith('/api/auth/login')) {
        unauthorizedHandler?.();
      }

      throw new ApiError(message, response.status, retryable);
    }

    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof TimeoutError) throw reason;
      throw new ApiError('La solicitud se canceló.', 0, false);
    }
    // Error de red (sin respuesta): normalmente transitorio.
    throw new ApiError('No se pudo conectar con el servidor. Comprueba tu conexión.', 0, true);
  } finally {
    clearTimeout(timer);
    detach();
  }
}

/**
 * Petición tipada al API.
 *
 * Reintenta automáticamente en GET/HEAD, y en el resto de métodos solo si se
 * envía `Idempotency-Key` (reintentar un cobro sin clave podría duplicarlo).
 */
export async function api<T>(path: string, init: RequestInit = {}, options: ApiOptions = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hasIdempotencyKey = Object.keys(init.headers ?? {}).some(
    (header) => header.toLowerCase() === 'idempotency-key',
  );
  const canRetry = IDEMPOTENT_METHODS.has(method) || hasIdempotencyKey;
  const maxRetries = canRetry ? (options.retries ?? MAX_RETRIES) : 0;

  const request: RequestInit = {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  };

  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    try {
      return await attempt<T>(path, request, timeoutMs, options.signal);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError && error.retryable;
      // Un 401/403/409/422 no mejora por reintentar.
      if (!retryable || attemptIndex === maxRetries) break;
      await sleep(backoffDelay(attemptIndex));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ApiError('No se pudo completar la solicitud.', 500, false);
}

/** Descarga binaria (documentos de identidad). */
export async function apiFile(path: string, options: ApiOptions = {}): Promise<Blob> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const detach = combineSignals(controller, options.signal);
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);

  try {
    const response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'image/*' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await readJson(response);
      const message =
        typeof body.error === 'string' ? body.error : 'No se pudo abrir el documento.';
      if (response.status === 401) unauthorizedHandler?.();
      throw new ApiError(message, response.status, RETRYABLE_STATUS.has(response.status));
    }
    return response.blob();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof TimeoutError) throw reason;
      throw new ApiError('La descarga se canceló.', 0, false);
    }
    throw new ApiError('No se pudo descargar el documento.', 0, true);
  } finally {
    clearTimeout(timer);
    detach();
  }
}

// ---------------------------------------------------------------------------
// Tipos compartidos con el servidor
// ---------------------------------------------------------------------------

export interface SessionUser { id: string; name: string; email: string; role: 'admin'|'supervisor'|'collector'; language: 'es'|'en'|'fr'; theme: 'dark'|'light' }
export interface Settings { companyName: string; currency: 'DOP'|'USD'|'EUR'; locale: 'es'|'en'|'fr'; timezone: string; graceDaysDefault: number }
export interface Metrics { cashAvailable: number; contributedCapital: number; activeLoans: number; principalOutstanding: number; collectedIncome: number; accruedPending: number; expenses: number; netProfitCollected: number; activeClients: number; pausedLoans: number }
export interface Client { id: string; firstName: string; lastName: string; documentType: string; documentNumber: string; phone: string; countryCode:string; email: string|null; address?:string|null; status: string; createdAt: string }
export interface Movement { id: string; type: string; direction: 'in'|'out'; amount: string; capitalComponent: string; currentInterest: string; lateInterest: string; penalty: string; description: string; occurredAt: string }
export interface Loan { id: string; product: 'traditional'|'periodic_interest'|'fixed_periodic_interest'; principal: string; principal_outstanding: string; monthlyRate: string; status: 'active'|'paused'|'paid'|'cancelled'; firstDueDate: string; graceDays: number; currency: string; createdAt: string; firstName: string; lastName: string; documentNumber: string; installmentCount: number; incomePending: string }
export interface ClientProfile {client:Client & {birthDate:string|null;guarantorClientId:string|null;guarantor:Pick<Client,'id'|'firstName'|'lastName'|'documentType'|'documentNumber'|'phone'>|null};loans:Loan[];guarantees:Array<{id:string;loanId:string|null;guaranteeType:string;description:string;estimatedValue:string|null;status:'active'|'in_process'|'released'|'executed';notes:string|null;createdAt:string}>;loanCounts:{active:number;paid:number;total:number;all:number}}
export interface PaymentBreakdown { capital: string; currentInterest: string; lateInterest: string; penalty: string }
export type CurrentCycleInterestOption = 'exact_days' | 'fifteen_days' | 'full_month';
export interface PayoffOptionItem { key: CurrentCycleInterestOption; label: string; days: number; interestAmount: string; totalAmount: string; available: boolean; reasonIfNotAvailable?: string }
export interface PayoffOptionsData { currentOption: CurrentCycleInterestOption; elapsedDays: number; cycleDays: number; options: PayoffOptionItem[] }
export interface PayoffDetails { option: CurrentCycleInterestOption; optionLabel: string; elapsedDays: number; chargedDays: number; cycleDays: number; explanation: string }
export interface PaymentHistoryItem { id: string; amount: string; paidAt: string; paymentMethod: string; reference: string | null; kind: string; receivedBy: string; description?: string; breakdown?: PaymentBreakdown }
export interface PaymentReceiptData { id: string; loanId: string; clientName: string; clientPhone?: string; clientDocument?: string; product?: string; amount: string; currency: string; kind?: string; status: string; paymentMethod: string; reference?: string | null; paidAt: string; receivedBy: string; remainingBalance: string; description?: string; breakdown?: PaymentBreakdown; payoffDetails?: PayoffDetails }
export interface LoanDetailInstallment { id:string;number:number;dueDate:string;periodStart:string;daysInCycle:number;status:string;principalDue:string;principalPaid:string;interestTarget:string;interestPaid:string;interestAccrued:string;lateAccrued:string;penaltyAccrued:string;latePaid:string;penaltyPaid:string }
export interface LoanDetail { loan:Loan & {clientId:string;principalOutstanding:string;interestPeriod:string;frequency:string|null;dueDay:number|null;pausedDays:number;notes:string|null;documentType:string;phone:string;email:string|null;address:string|null};installments:LoanDetailInstallment[];payments:PaymentHistoryItem[];totalPaid:string }

export interface PortfolioReport { currency:string; period:{from:string;to:string}; portfolio:Array<{product:Loan['product'];status:Loan['status']|'draft';loanCount:number;principalOriginated:number;principalOutstanding:number}>; collected:{capitalReturned:number;currentInterest:number;lateInterest:number;penalty:number;totalIncome:number}; expenses:{total:number;count:number;byCategory:Array<{category:string;total:number;count:number}>}; netProfitCollected:number; daily:Array<{date:string;collectedIncome:number;expenses:number}> }
