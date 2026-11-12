import { addDays, calculatePeriodInterest, dayDifference, toCents } from './finance.js';

export interface PrincipalPaymentRow { installment_id:string|number; paid_on:string; amount:string }
export interface LoanAdjustmentRow { action:string; action_date:string; paused_at:string|null }

interface PauseInterval { start:string; end:string|null }

function activeDaysBetween(start:string,end:string,pauses:PauseInterval[]):number {
  if(start>end) return 0;
  let days=dayDifference(start,end)+1;
  for(const pause of pauses){
    const pausedStart=addDays(pause.start,1);
    const pausedEnd=pause.end?addDays(pause.end,-1):end;
    const overlapStart=start>pausedStart?start:pausedStart;
    const overlapEnd=end<pausedEnd?end:pausedEnd;
    if(overlapStart<=overlapEnd) days-=dayDifference(overlapStart,overlapEnd)+1;
  }
  return Math.max(0,days);
}

export function calculateTraditionalLateInterest(input:{dueDate:string;today:string;principalDue:string;principalPaid:string;rate:bigint;graceDays:number;payments:PrincipalPaymentRow[];adjustments:LoanAdjustmentRow[]}):bigint {
  const pauses:PauseInterval[]=[];
  let openPause:string|null=null;
  for(const adjustment of input.adjustments){
    if(adjustment.action==='pause') openPause=adjustment.paused_at??adjustment.action_date;
    if(adjustment.action==='resume'&&openPause){pauses.push({start:openPause,end:adjustment.action_date});openPause=null;}
  }
  if(openPause) pauses.push({start:openPause,end:null});

  const firstDay=addDays(input.dueDate,1);
  if(activeDaysBetween(firstDay,input.today,pauses)<=input.graceDays) return 0n;

  const principalPaidByDay=new Map<string,bigint>();
  for(const payment of input.payments){
    const day=String(payment.paid_on).slice(0,10);
    principalPaidByDay.set(day,(principalPaidByDay.get(day)??0n)+toCents(payment.amount));
  }

  const principalDue=toCents(input.principalDue);
  const principalAlreadyPaid=toCents(input.principalPaid);
  let principal=principalDue>principalAlreadyPaid?principalDue-principalAlreadyPaid:0n;
  if(input.payments.length){
    const alreadyPaid=input.payments.filter((payment)=>String(payment.paid_on).slice(0,10)<=input.dueDate).reduce((sum,payment)=>sum+toCents(payment.amount),0n);
    principal=principalDue>alreadyPaid?principalDue-alreadyPaid:0n;
  }
  let accrued=0n;
  const accrueSegment=(start:string,end:string)=>{
    const activeDays=activeDaysBetween(start,end,pauses);
    if(activeDays>0&&principal>0n) accrued+=calculatePeriodInterest(principal,input.rate,1,'day')*BigInt(activeDays);
  };
  let cursor=firstDay;
  const paymentDays=[...principalPaidByDay.keys()].filter((day)=>day>input.dueDate&&day<=input.today).sort();
  for(const day of paymentDays){
    accrueSegment(cursor,day);
    const payment=principalPaidByDay.get(day)!;
    principal=principal>payment?principal-payment:0n;
    cursor=addDays(day,1);
  }
  accrueSegment(cursor,input.today);
  return accrued;
}
