import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTraditionalLateInterest, type LoanAdjustmentRow, type PrincipalPaymentRow } from '../../server/src/traditional-accrual.js';
import { centsToAmount, rateToUnits } from '../../server/src/finance.js';

const rate=rateToUnits('3');
const noPayments:PrincipalPaymentRow[]=[];
const noAdjustments:LoanAdjustmentRow[]=[];

function accrue(input:Partial<Parameters<typeof calculateTraditionalLateInterest>[0]>={}){
  return centsToAmount(calculateTraditionalLateInterest({dueDate:'2026-01-01',today:'2026-01-04',principalDue:'1000.00',principalPaid:'0.00',rate,graceDays:0,payments:noPayments,adjustments:noAdjustments,...input}));
}

test('retroactively accrues from the due date once the configured grace period is exceeded',()=>{
  assert.equal(accrue({graceDays:2,today:'2026-01-03'}),'0.00');
  assert.equal(accrue({graceDays:2,today:'2026-01-04'}),'3.00');
});

test('a principal payment affects interest from the following day and preserves earlier accrual',()=>{
  const payments:PrincipalPaymentRow[]=[{installment_id:1,paid_on:'2026-01-03',amount:'500.00'}];
  assert.equal(accrue({payments,today:'2026-01-04'}),'2.50');
});

test('a pause freezes accrual without resetting grace or erasing prior accrued days',()=>{
  const adjustments:LoanAdjustmentRow[]=[
    {action:'pause',action_date:'2026-01-04',paused_at:'2026-01-04'},
    {action:'resume',action_date:'2026-01-10',paused_at:null},
  ];
  assert.equal(accrue({graceDays:2,today:'2026-01-10',adjustments}),'4.00');
});

test('a currently paused loan accrues no days after its pause date',()=>{
  const adjustments:LoanAdjustmentRow[]=[{action:'pause',action_date:'2026-01-04',paused_at:'2026-01-04'}];
  assert.equal(accrue({graceDays:2,today:'2026-01-10',adjustments}),'3.00');
});

test('multiple pause and resume periods do not restart the grace counter',()=>{
  const adjustments:LoanAdjustmentRow[]=[
    {action:'pause',action_date:'2026-01-04',paused_at:'2026-01-04'},
    {action:'resume',action_date:'2026-01-06',paused_at:null},
    {action:'pause',action_date:'2026-01-07',paused_at:'2026-01-07'},
    {action:'resume',action_date:'2026-01-09',paused_at:null},
  ];
  assert.equal(accrue({graceDays:2,today:'2026-01-10',adjustments}),'7.00');
});
