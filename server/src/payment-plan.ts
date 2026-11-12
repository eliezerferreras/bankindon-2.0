import { calculateDailyAccrual, centsToAmount, dayDifference, toCents } from './finance.js';

export type PaymentMode = 'amount' | 'installments' | 'payoff';
export type PaymentComponent = 'penalty' | 'late_interest' | 'current_interest' | 'principal';
export type CurrentCycleInterestOption = 'exact_days' | 'fifteen_days' | 'full_month';

export interface InstallmentBalance {
  id: string;
  number: number;
  dueDate: string;
  periodStart?: string;
  daysInCycle?: number;
  interestAccrued?: string;
  status: string;
  principalDue: string;
  principalPaid: string;
  interestTarget: string;
  interestPaid: string;
  lateAccrued: string;
  penaltyAccrued: string;
  latePaid: string;
  penaltyPaid: string;
}

export interface Allocation {
  installmentId: string | null;
  component: PaymentComponent;
  amount: string;
}

export interface PaymentPlan {
  amount: string;
  allocations: Allocation[];
  remainingBalance: string;
  installmentCount: number;
}

export interface PayoffOptionItem {
  key: CurrentCycleInterestOption;
  label: string;
  days: number;
  interestAmount: string;
  totalAmount: string;
  available: boolean;
  reasonIfNotAvailable?: string;
}

export interface PayoffOptionsData {
  currentOption: CurrentCycleInterestOption;
  elapsedDays: number;
  cycleDays: number;
  options: PayoffOptionItem[];
}

export interface PeriodicPayoffCalculation {
  payoffOptions: PayoffOptionsData;
  adjustedBalances: InstallmentBalance[];
  adjustedInstallmentId: string;
  chosenTargetInterest: string;
  chosenOption: CurrentCycleInterestOption;
  elapsedDays: number;
  chargedDays: number;
  cycleDays: number;
  optionLabel: string;
  explanation: string;
}

export function calculatePeriodicPayoffOptions(
  rows: InstallmentBalance[],
  principalOutstanding: string,
  today: string,
  chosenOption: CurrentCycleInterestOption = 'exact_days',
): PeriodicPayoffCalculation | null {
  const eligible = rows.filter((row) => !['paid', 'waived'].includes(row.status));
  if (!eligible.length) return null;

  const currentInstallment =
    eligible.find((row) => row.periodStart && row.periodStart <= today && row.dueDate >= today) ??
    eligible.at(-1);

  if (!currentInstallment || !currentInstallment.periodStart) return null;

  const periodStart = currentInstallment.periodStart;
  const dueDate = currentInstallment.dueDate;
  const cycleDays = currentInstallment.daysInCycle ?? Math.max(1, dayDifference(periodStart, dueDate));
  const elapsedDays = Math.max(0, dayDifference(periodStart, today));

  const baseMonthlyTarget = toCents(currentInstallment.interestTarget);
  const currentPaidInterest = toCents(currentInstallment.interestPaid);

  const pastInstallments = eligible.filter((r) => r.id !== currentInstallment.id);
  const pastPenalty = pastInstallments.reduce((sum, r) => sum + (toCents(r.penaltyAccrued) - toCents(r.penaltyPaid)), 0n);
  const pastLate = pastInstallments.reduce((sum, r) => sum + (toCents(r.lateAccrued) - toCents(r.latePaid)), 0n);
  const pastInterest = pastInstallments.reduce((sum, r) => sum + (toCents(r.interestTarget) - toCents(r.interestPaid)), 0n);
  const pastPrincipal = pastInstallments.reduce((sum, r) => sum + (toCents(r.principalDue) - toCents(r.principalPaid)), 0n);

  const principalCents = toCents(principalOutstanding);
  const pastReceivable = pastPenalty + pastLate + pastInterest + pastPrincipal + principalCents;

  // 1) exact_days
  const exactChargedDays = Math.min(cycleDays, elapsedDays);
  const exactTarget = calculateDailyAccrual(baseMonthlyTarget, exactChargedDays, cycleDays);
  const exactNetInterest = exactTarget > currentPaidInterest ? exactTarget - currentPaidInterest : 0n;
  const exactTotal = pastReceivable + exactNetInterest;

  // 2) fifteen_days (solo permitido si elapsedDays <= 20)
  const fifteenAllowed = elapsedDays <= 20;
  const fifteenTarget = calculateDailyAccrual(baseMonthlyTarget, 15, cycleDays);
  const fifteenNetInterest = fifteenTarget > currentPaidInterest ? fifteenTarget - currentPaidInterest : 0n;
  const fifteenTotal = pastReceivable + fifteenNetInterest;

  // 3) full_month
  const fullTarget = baseMonthlyTarget;
  const fullNetInterest = fullTarget > currentPaidInterest ? fullTarget - currentPaidInterest : 0n;
  const fullTotal = pastReceivable + fullNetInterest;

  const options: PayoffOptionItem[] = [
    {
      key: 'exact_days',
      label: `Días reales transcurridos (${exactChargedDays} ${exactChargedDays === 1 ? 'día' : 'días'})`,
      days: exactChargedDays,
      interestAmount: centsToAmount(exactNetInterest),
      totalAmount: centsToAmount(exactTotal),
      available: true,
    },
    {
      key: 'fifteen_days',
      label: 'Quincena fija (15 días)',
      days: 15,
      interestAmount: centsToAmount(fifteenNetInterest),
      totalAmount: centsToAmount(fifteenTotal),
      available: fifteenAllowed,
      reasonIfNotAvailable: fifteenAllowed ? undefined : 'No disponible (han transcurrido más de 20 días)',
    },
    {
      key: 'full_month',
      label: `Mes completo (${cycleDays} días)`,
      days: cycleDays,
      interestAmount: centsToAmount(fullNetInterest),
      totalAmount: centsToAmount(fullTotal),
      available: true,
    },
  ];

  const effectiveOption: CurrentCycleInterestOption =
    chosenOption === 'fifteen_days' && !fifteenAllowed ? 'exact_days' : chosenOption;

  const chosenTarget =
    effectiveOption === 'fifteen_days'
      ? fifteenTarget
      : effectiveOption === 'full_month'
      ? fullTarget
      : exactTarget;

  const chargedDays =
    effectiveOption === 'fifteen_days'
      ? 15
      : effectiveOption === 'full_month'
      ? cycleDays
      : exactChargedDays;

  const optionLabel =
    effectiveOption === 'fifteen_days'
      ? 'Quincena fija (15 días)'
      : effectiveOption === 'full_month'
      ? `Mes completo (${cycleDays} días)`
      : `Días reales (${exactChargedDays} ${exactChargedDays === 1 ? 'día' : 'días'})`;

  const explanation =
    effectiveOption === 'fifteen_days'
      ? `Liquidación total: cobro de quincena fija de 15 días de interés proporcional (habiendo transcurrido ${elapsedDays} ${elapsedDays === 1 ? 'día' : 'días'} de ${cycleDays} días del ciclo).`
      : effectiveOption === 'full_month'
      ? `Liquidación total: cobro del mes completo (${cycleDays} días de interés) correspondiente al ciclo en curso.`
      : `Liquidación total: cobro de ${exactChargedDays} ${exactChargedDays === 1 ? 'día' : 'días'} de interés proporcional según días transcurridos de ${cycleDays} días del ciclo.`;

  const adjustedBalances = rows.map((r) => {
    if (r.id === currentInstallment.id) {
      return {
        ...r,
        interestTarget: centsToAmount(chosenTarget),
        interestAccrued: centsToAmount(chosenTarget),
      };
    }
    return r;
  });

  return {
    payoffOptions: {
      currentOption: effectiveOption,
      elapsedDays,
      cycleDays,
      options,
    },
    adjustedBalances,
    adjustedInstallmentId: currentInstallment.id,
    chosenTargetInterest: centsToAmount(chosenTarget),
    chosenOption: effectiveOption,
    elapsedDays,
    chargedDays,
    cycleDays,
    optionLabel,
    explanation,
  };
}

export function planPayment(
  rows: InstallmentBalance[],
  mode: PaymentMode,
  amount?: string,
  installmentCount?: number,
  principalOutstanding?: string,
): PaymentPlan {
  const eligible = rows.filter((row) => !['paid', 'waived'].includes(row.status));
  const scoped = mode === 'installments' ? eligible.slice(0, installmentCount ?? 0) : eligible;
  const balances = scoped.map((row) => ({
    row,
    penalty: toCents(row.penaltyAccrued) - toCents(row.penaltyPaid),
    late: toCents(row.lateAccrued) - toCents(row.latePaid),
    interest: toCents(row.interestTarget) - toCents(row.interestPaid),
    principal: toCents(row.principalDue) - toCents(row.principalPaid),
  }));
  const receivable = balances.reduce((sum, item) => sum + item.penalty + item.late + item.interest + item.principal, 0n);
  const scheduledPrincipal = balances.reduce((sum, item) => sum + item.principal, 0n);
  const extraPrincipal =
    mode === 'installments'
      ? 0n
      : principalOutstanding === undefined
      ? 0n
      : toCents(principalOutstanding) > scheduledPrincipal
      ? toCents(principalOutstanding) - scheduledPrincipal
      : 0n;
  const total = receivable + extraPrincipal;
  let remaining = mode === 'amount' ? toCents(amount ?? '0') : total;
  if (remaining <= 0n) throw new Error('No hay saldo pendiente para pagar.');
  if (remaining > total) throw new Error(`El pago supera el saldo seleccionado de ${centsToAmount(total)}.`);
  const allocations: Allocation[] = [];
  const components: PaymentComponent[] = ['penalty', 'late_interest', 'current_interest', 'principal'];
  for (const component of components) {
    for (const item of balances) {
      if (remaining <= 0n) break;
      const key =
        component === 'penalty'
          ? 'penalty'
          : component === 'late_interest'
          ? 'late'
          : component === 'current_interest'
          ? 'interest'
          : 'principal';
      const available = item[key];
      if (available <= 0n) continue;
      const applied = available < remaining ? available : remaining;
      allocations.push({ installmentId: item.row.id, component, amount: centsToAmount(applied) });
      item[key] -= applied;
      remaining -= applied;
    }
    if (component === 'principal' && remaining > 0n && mode !== 'installments') {
      const applied = extraPrincipal < remaining ? extraPrincipal : remaining;
      if (applied > 0n) {
        allocations.push({ installmentId: null, component: 'principal', amount: centsToAmount(applied) });
        remaining -= applied;
      }
    }
    if (remaining <= 0n) break;
  }
  return {
    amount: centsToAmount(mode === 'amount' ? toCents(amount ?? '0') : total),
    allocations,
    remainingBalance: centsToAmount(total - (mode === 'amount' ? toCents(amount ?? '0') : total)),
    installmentCount: new Set(allocations.map((item) => item.installmentId).filter((id) => id !== null)).size,
  };
}
