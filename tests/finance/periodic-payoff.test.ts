import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePeriodicPayoffOptions, planPayment, type InstallmentBalance } from '../../server/src/payment-plan.js';

function createMockPeriodicInstallments(): InstallmentBalance[] {
  return [
    {
      id: 'inst-1',
      number: 1,
      dueDate: '2026-01-01',
      periodStart: '2025-12-01',
      daysInCycle: 31,
      interestAccrued: '3000.00',
      status: 'overdue',
      principalDue: '0.00',
      principalPaid: '0.00',
      interestTarget: '3000.00',
      interestPaid: '0.00',
      lateAccrued: '0.00',
      penaltyAccrued: '200.00',
      latePaid: '0.00',
      penaltyPaid: '0.00',
    },
    {
      id: 'inst-2',
      number: 2,
      dueDate: '2026-02-01',
      periodStart: '2026-01-01',
      daysInCycle: 31,
      interestAccrued: '968.00',
      status: 'open',
      principalDue: '0.00',
      principalPaid: '0.00',
      interestTarget: '3000.00',
      interestPaid: '0.00',
      lateAccrued: '0.00',
      penaltyAccrued: '0.00',
      latePaid: '0.00',
      penaltyPaid: '0.00',
    },
  ];
}

test('periodic payoff options when 10 days elapsed: fifteen_days is available', () => {
  const installments = createMockPeriodicInstallments();
  // today: 2026-01-11 -> elapsed = 10 days
  const result = calculatePeriodicPayoffOptions(installments, '100000.00', '2026-01-11', 'exact_days');
  assert.ok(result);
  assert.equal(result.elapsedDays, 10);
  assert.equal(result.cycleDays, 31);
  assert.equal(result.payoffOptions.options.length, 3);

  const exactOpt = result.payoffOptions.options.find((o) => o.key === 'exact_days');
  const fifteenOpt = result.payoffOptions.options.find((o) => o.key === 'fifteen_days');
  const monthOpt = result.payoffOptions.options.find((o) => o.key === 'full_month');

  assert.ok(exactOpt);
  assert.ok(fifteenOpt);
  assert.ok(monthOpt);

  assert.equal(exactOpt.available, true);
  assert.equal(fifteenOpt.available, true); // 10 <= 20
  assert.equal(monthOpt.available, true);

  // Overdue: 200 (penalty) + 3000 (past interest) = 3200
  // Principal: 100000
  // Base without current interest = 103200
  // Exact 10 days on 3000 over 31 days: roundedRatio(300000 * 10, 31) = 96774 cents = 967.74
  assert.equal(exactOpt.interestAmount, '967.74');
  assert.equal(exactOpt.totalAmount, '104167.74');

  // 15 days on 3000 over 31 days: roundedRatio(300000 * 15, 31) = 145161 cents = 1451.61
  assert.equal(fifteenOpt.interestAmount, '1451.61');
  assert.equal(fifteenOpt.totalAmount, '104651.61');

  // Full month: 3000.00
  assert.equal(monthOpt.interestAmount, '3000.00');
  assert.equal(monthOpt.totalAmount, '106200.00');
});

test('periodic payoff options when 23 days elapsed: fifteen_days is disabled', () => {
  const installments = createMockPeriodicInstallments();
  // today: 2026-01-24 -> elapsed = 23 days
  const result = calculatePeriodicPayoffOptions(installments, '100000.00', '2026-01-24', 'fifteen_days');
  assert.ok(result);
  assert.equal(result.elapsedDays, 23);

  const fifteenOpt = result.payoffOptions.options.find((o) => o.key === 'fifteen_days');
  assert.ok(fifteenOpt);
  assert.equal(fifteenOpt.available, false);
  assert.ok(fifteenOpt.reasonIfNotAvailable?.includes('más de 20 días'));

  // Should fallback effectiveOption to exact_days since fifteen_days is not available
  assert.equal(result.chosenOption, 'exact_days');
});

test('planPayment with adjustedBalances balances out to 0 remaining and prioritizes penalty then overdue interest then floating then principal', () => {
  const installments = createMockPeriodicInstallments();
  // today: 2026-01-11 -> elapsed = 10 days, user chooses fifteen_days
  const result = calculatePeriodicPayoffOptions(installments, '100000.00', '2026-01-11', 'fifteen_days');
  assert.ok(result);
  assert.equal(result.chosenOption, 'fifteen_days');

  const plan = planPayment(result.adjustedBalances, 'payoff', undefined, undefined, '100000.00');
  assert.equal(plan.amount, '104651.61');
  assert.equal(plan.remainingBalance, '0.00');

  // Check allocations order:
  // 1. penalty on inst-1 (200.00)
  // 2. current_interest on inst-1 (3000.00)
  // 3. current_interest on inst-2 (1451.61)
  // 4. principal (100000.00)
  assert.equal(plan.allocations[0].installmentId, 'inst-1');
  assert.equal(plan.allocations[0].component, 'penalty');
  assert.equal(plan.allocations[0].amount, '200.00');

  assert.equal(plan.allocations[1].installmentId, 'inst-1');
  assert.equal(plan.allocations[1].component, 'current_interest');
  assert.equal(plan.allocations[1].amount, '3000.00');

  assert.equal(plan.allocations[2].installmentId, 'inst-2');
  assert.equal(plan.allocations[2].component, 'current_interest');
  assert.equal(plan.allocations[2].amount, '1451.61');

  assert.equal(plan.allocations[3].component, 'principal');
  assert.equal(plan.allocations[3].amount, '100000.00');
});

