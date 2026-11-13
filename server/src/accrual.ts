import { pool } from './db/pool.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2';
import {
  addDays,
  addMonthAtDay,
  businessDate,
  calculateDailyAccrual,
  calculateMonthlyInterest,
  calculatePeriodInterest,
  centsToAmount,
  dateOnly,
  dayDifference,
  rateToUnits,
  toCents,
  type Frequency,
} from './finance.js';
import {
  calculateTraditionalLateInterest,
  type LoanAdjustmentRow,
  type PrincipalPaymentRow,
} from './traditional-accrual.js';

/**
 * Devengo de intereses.
 *
 * Antes: un único ciclo bloqueaba (`FOR UPDATE`) TODOS los préstamos y TODAS
 * sus cuotas, y se ejecutaba en cada cobro. Consecuencias:
 *   - el coste de un cobro crecía con el tamaño de la cartera (O(n));
 *   - cualquier error en un préstamo abortaba el ciclo completo;
 *   - dos instancias del API producían devengos duplicados y deadlocks.
 *
 * Ahora:
 *   - cada préstamo se devenga en su propia transacción y con su propio lock
 *     de fila: un préstamo roto no afecta a los demás;
 *   - el barrido nocturno (varias cuotas) toma un lock de aviso de MySQL, de
 *     modo que solo una instancia lo ejecuta;
 *   - los cobros usan `runAccrualCycleForLoan`, acotado a un préstamo;
 *   - solo se escriben las filas cuyo valor realmente cambia.
 *
 * El cálculo es determinista a partir de (period_start, due_date, pagos,
 * ajustes, hoy), por lo que repetir el ciclo es idempotente.
 */

const PORTFOLIO_LOCK = 'bankindon:accrual:portfolio';

export interface AccrualLogger {
  error(payload: unknown, message: string): void;
  warn?(payload: unknown, message: string): void;
}

let logger: AccrualLogger = {
  error: (payload, message) => console.error(message, payload),
  warn: (payload, message) => console.warn(message, payload),
};

export function setAccrualLogger(next: AccrualLogger): void {
  logger = next;
}

interface LoanRow {
  id: string;
  product: 'traditional' | 'periodic_interest' | 'fixed_periodic_interest';
  principal: string;
  principal_outstanding: string;
  interest_rate: string;
  late_interest_rate: string;
  installment_frequency: Frequency | null;
  due_day: number | null;
  grace_days: number;
  paused_days: number;
  status: 'active' | 'paused';
  currency: string;
}

interface InstallmentRow {
  id: string;
  installment_number: number;
  period_start: string;
  due_date: string;
  principal_due: string;
  interest_target: string;
  interest_accrued: string;
  interest_paid: string;
  late_interest_accrued: string;
  penalty_accrued: string;
  principal_paid: string;
  status: string;
}

export interface AccrualSummary {
  /** false cuando otra instancia tenía el lock del barrido. */
  ran: boolean;
  processed: number;
  failed: number;
  durationMs: number;
}

/**
 * Ejecuta `task` con un lock de aviso de MySQL (`GET_LOCK`).
 *
 * El lock vive en la conexión que lo toma, por eso `task` debe usar OTRAS
 * conexiones del pool para sus transacciones (DB_POOL_SIZE >= 2, validado en
 * config). Devuelve `null` si otra instancia ya tenía el lock.
 */
async function withNamedLock<T>(
  name: string,
  timeoutSeconds: number,
  task: () => Promise<T>,
): Promise<T | null> {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [
      name,
      timeoutSeconds,
    ]);
    if (Number(rows[0]?.acquired) !== 1) return null;
    try {
      return await task();
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [name]).catch((error: unknown) => {
        logger.error({ err: error, lock: name }, 'No se pudo liberar el lock de devengo.');
      });
    }
  } finally {
    connection.release();
  }
}

async function resolveBusinessDate(connection: PoolConnection): Promise<string | null> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT timezone FROM company_settings WHERE id=1',
  );
  const timezone = rows[0]?.timezone as string | undefined;
  if (!timezone) return null;
  return businessDate(timezone);
}

/**
 * Devenga un único préstamo dentro de una transacción ya abierta.
 * Devuelve cuántas cuotas se modificaron (0 = no había nada que actualizar).
 */
async function accrueLoan(connection: PoolConnection, loan: LoanRow, today: string): Promise<number> {
  if (loan.status === 'paused') return 0;

  const rate = rateToUnits(loan.interest_rate);
  const [existingRows] = await connection.execute(
    'SELECT id,installment_number,period_start,due_date,principal_due,interest_target,interest_accrued,interest_paid,late_interest_accrued,penalty_accrued,principal_paid,status FROM installments WHERE loan_id=? ORDER BY installment_number FOR UPDATE',
    [loan.id],
  );
  const installments: InstallmentRow[] = (existingRows as Array<Record<string, unknown>>).map((row) => ({
    ...(row as unknown as InstallmentRow),
    period_start: dateOnly(row.period_start as string | Date),
    due_date: dateOnly(row.due_date as string | Date),
  }));

  // Productos periódicos: genera las cuotas que falten hasta hoy.
  if (loan.product !== 'traditional' && toCents(loan.principal_outstanding) > 0n) {
    let last = installments.at(-1);
    let cycles = 0;
    while (last && last.due_date < today && cycles < 240) {
      const nextDue = addMonthAtDay(last.due_date, loan.due_day ?? Number(last.due_date.slice(8, 10)));
      if (installments.some((item) => item.due_date === nextDue)) break;
      const nextNumber = last.installment_number + 1;
      const base =
        loan.product === 'fixed_periodic_interest'
          ? toCents(loan.principal)
          : toCents(loan.principal_outstanding);
      const target = calculateMonthlyInterest(base, rate);
      const [result] = await connection.execute(
        "INSERT INTO installments (loan_id,installment_number,period_start,due_date,principal_due,interest_target,interest_accrued,status) VALUES (?,?,?,?,0,?,0,'open')",
        [loan.id, nextNumber, last.due_date, nextDue, centsToAmount(target)],
      );
      const created: InstallmentRow = {
        id: String((result as ResultSetHeader).insertId),
        installment_number: nextNumber,
        period_start: last.due_date,
        due_date: nextDue,
        principal_due: '0.00',
        interest_target: centsToAmount(target),
        interest_accrued: '0.00',
        interest_paid: '0.00',
        late_interest_accrued: '0.00',
        penalty_accrued: '0.00',
        principal_paid: '0.00',
        status: 'open',
      };
      installments.push(created);
      last = created;
      cycles += 1;
    }
    if (cycles === 240) {
      throw new Error(
        `El préstamo ${loan.id} tiene más de 240 ciclos pendientes de generar; requiere revisión manual.`,
      );
    }
  }

  let principalPayments: PrincipalPaymentRow[] = [];
  let pauseHistory: LoanAdjustmentRow[] = [];
  if (loan.product === 'traditional') {
    const [paymentRows] = await connection.execute(
      "SELECT a.installment_id,DATE_FORMAT(p.paid_at,'%Y-%m-%d') AS paid_on,SUM(a.amount) AS amount FROM payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.status='posted' WHERE p.loan_id=? AND a.component='principal' AND a.installment_id IS NOT NULL GROUP BY a.installment_id,paid_on",
      [loan.id],
    );
    principalPayments = paymentRows as PrincipalPaymentRow[];

    const [adjustmentRows] = await connection.execute(
      "SELECT action,COALESCE(JSON_UNQUOTE(JSON_EXTRACT(after_data,'$.resumedAt')),DATE_FORMAT(created_at,'%Y-%m-%d')) AS action_date,JSON_UNQUOTE(JSON_EXTRACT(after_data,'$.pausedAt')) AS paused_at FROM loan_adjustments WHERE loan_id=? AND action IN ('pause','resume') ORDER BY created_at,id",
      [loan.id],
    );
    pauseHistory = adjustmentRows as LoanAdjustmentRow[];
  }

  let changed = 0;
  for (const installment of installments) {
    if (installment.status === 'paid' || installment.status === 'waived') continue;

    const due = installment.due_date;
    const daysToDue = dayDifference(installment.period_start, due);
    let accrued: bigint;
    let late = 0n;
    let penalty = 0n;

    if (loan.product === 'traditional') {
      accrued = toCents(installment.interest_target);
      late = calculateTraditionalLateInterest({
        dueDate: due,
        today,
        principalDue: installment.principal_due,
        principalPaid: installment.principal_paid,
        rate,
        graceDays: loan.grace_days,
        payments: principalPayments.filter((payment) => String(payment.installment_id) === installment.id),
        adjustments: pauseHistory,
      });
      if (late > 0n) penalty = calculateMonthlyInterest(late, rate);
    } else {
      const elapsed = Math.min(daysToDue, dayDifference(installment.period_start, today));
      const target = toCents(installment.interest_target);
      const paid = toCents(installment.interest_paid) > target ? target : toCents(installment.interest_paid);
      // Lo pagado por adelantado ya cubre esa parte; solo devenga el resto.
      accrued = paid + calculateDailyAccrual(target - paid, elapsed, daysToDue);
      if (today > addDays(due, loan.grace_days)) {
        const daysLate = dayDifference(addDays(due, loan.grace_days), today);
        const unpaidInterest = toCents(installment.interest_target) - toCents(installment.interest_paid);
        penalty = calculatePeriodInterest(unpaidInterest, rate, daysLate, 'day');
      }
    }

    const dueStatus =
      today < due ? 'open' : today <= addDays(due, loan.grace_days) ? 'due' : 'overdue';

    const accruedAmount = centsToAmount(accrued);
    const lateAmount = centsToAmount(late);
    const penaltyAmount = centsToAmount(penalty);

    // Evita amplificación de escrituras: la mayoría de cuotas no cambian.
    const unchanged =
      installment.interest_accrued === accruedAmount &&
      installment.late_interest_accrued === lateAmount &&
      installment.penalty_accrued === penaltyAmount &&
      installment.status === dueStatus;
    if (unchanged) continue;

    await connection.execute(
      'UPDATE installments SET interest_accrued=?,late_interest_accrued=?,penalty_accrued=?,status=? WHERE id=?',
      [accruedAmount, lateAmount, penaltyAmount, dueStatus, installment.id],
    );
    changed += 1;
  }

  return changed;
}

/** Devenga un préstamo en su propia transacción, serializado por su fila. */
async function accrueLoanInTransaction(loanId: string, today?: string): Promise<number> {
  const connection = await pool.getConnection();
  let inTransaction = false;
  try {
    await connection.beginTransaction();
    inTransaction = true;

    const businessToday = today ?? (await resolveBusinessDate(connection));
    if (!businessToday) {
      await connection.rollback();
      inTransaction = false;
      return 0;
    }

    const [loanRows] = await connection.execute(
      "SELECT id,product,principal,principal_outstanding,interest_rate,late_interest_rate,installment_frequency,due_day,grace_days,paused_days,status,currency FROM loans WHERE id=? AND status IN ('active','paused') FOR UPDATE",
      [loanId],
    );
    const loan = (loanRows as LoanRow[])[0];
    if (!loan) {
      await connection.rollback();
      inTransaction = false;
      return 0;
    }

    const changed = await accrueLoan(connection, loan, businessToday);
    await connection.commit();
    inTransaction = false;
    return changed;
  } catch (error) {
    if (inTransaction) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Devengo acotado a un préstamo. Úsalo en rutas de cobro/detalle: el coste
 * deja de depender del tamaño de la cartera.
 */
export async function runAccrualCycleForLoan(loanId: string): Promise<void> {
  await accrueLoanInTransaction(loanId);
}

/**
 * Barrido de cartera. Seguro con varias instancias del API: solo la que toma
 * el lock de aviso ejecuta el trabajo; las demás salen de inmediato.
 */
export async function runAccrualCycle(): Promise<AccrualSummary> {
  const startedAt = Date.now();
  const summary = await withNamedLock(PORTFOLIO_LOCK, 0, async (): Promise<AccrualSummary> => {
    const [loanRows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM loans WHERE status IN ('active','paused') ORDER BY id",
    );

    // La fecha de negocio se resuelve una vez para dar coherencia al barrido.
    const probe = await pool.getConnection();
    let today: string | null;
    try {
      today = await resolveBusinessDate(probe);
    } finally {
      probe.release();
    }
    if (!today) {
      logger.error({}, 'No hay zona horaria configurada; el devengo no puede ejecutarse.');
      return { ran: true, processed: 0, failed: 0, durationMs: Date.now() - startedAt };
    }

    let processed = 0;
    let failed = 0;
    for (const row of loanRows) {
      const loanId = String(row.id);
      try {
        await accrueLoanInTransaction(loanId, today);
        processed += 1;
      } catch (error) {
        // Aislamiento: un préstamo con datos inconsistentes no detiene al resto.
        failed += 1;
        logger.error({ err: error, loanId }, 'El devengo falló para un préstamo.');
      }
    }
    return { ran: true, processed, failed, durationMs: Date.now() - startedAt };
  });

  return summary ?? { ran: false, processed: 0, failed: 0, durationMs: Date.now() - startedAt };
}
