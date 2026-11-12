export type Frequency = 'day'|'week'|'fortnight'|'month';
const RATE_SCALE = 100_000n;
const DENOMINATOR = 100n * RATE_SCALE;

export function toCents(input: string | number): bigint {
  const value = String(input).trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) throw new Error('Importe monetario inválido.');
  const [whole, fraction=''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((fraction+'00').slice(0,2));
}

export function centsToAmount(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;
}

export function rateToUnits(rate: string | number): bigint {
  const value = String(rate).trim();
  if (!/^\d{1,3}(?:\.\d{1,5})?$/.test(value)) throw new Error('Tasa mensual inválida.');
  const [whole,fraction=''] = value.split('.');
  return BigInt(whole)*RATE_SCALE + BigInt((fraction+'00000').slice(0,5));
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('El divisor debe ser positivo.');
  return (numerator + denominator/2n) / denominator;
}

export function calculateMonthlyInterest(principalCents: bigint, rateUnits: bigint): bigint {
  return roundedRatio(principalCents*rateUnits, DENOMINATOR);
}

export function calculatePeriodInterest(principalCents: bigint, rateUnits: bigint, days: number, frequency: Frequency): bigint {
  if (frequency === 'month') return calculateMonthlyInterest(principalCents,rateUnits);
  return roundedRatio(principalCents*rateUnits*BigInt(Math.max(0,days)),DENOMINATOR*30n);
}

export function calculateDailyAccrual(targetCents: bigint, elapsedDays: number, cycleDays: number): bigint {
  if (targetCents <= 0n || elapsedDays <= 0 || cycleDays <= 0) return 0n;
  if (elapsedDays >= cycleDays) return targetCents;
  return roundedRatio(targetCents*BigInt(elapsedDays),BigInt(cycleDays));
}

export function businessDate(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const value = Object.fromEntries(parts.map((part)=>[part.type,part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function isCalendarDate(value:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value;
}

export function dateOnly(value:string|Date):string {
  return value instanceof Date ? value.toISOString().slice(0,10) : value.slice(0,10);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate()+days);
  return value.toISOString().slice(0,10);
}

export function dayDifference(start: string, end: string): number {
  return Math.max(0,Math.round((Date.parse(`${end}T00:00:00.000Z`)-Date.parse(`${start}T00:00:00.000Z`))/86_400_000));
}

export function addMonthAtDay(date: string, dueDay: number): string {
  const [year,month] = date.split('-').map(Number);
  const targetMonth = month === 12 ? 1 : month+1;
  const targetYear = month === 12 ? year+1 : year;
  const lastDay = new Date(Date.UTC(targetYear,targetMonth,0)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2,'0')}-${String(Math.min(dueDay,lastDay)).padStart(2,'0')}`;
}

export function nextDate(date: string, dueDay: number, frequency: Frequency): string {
  if (frequency === 'day') return addDays(date,1);
  if (frequency === 'week') return addDays(date,7);
  if (frequency === 'fortnight') return addDays(date,14);
  return addMonthAtDay(date,dueDay);
}

export function distributeCents(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new Error('Cantidad de cuotas inválida.');
  const base = total/BigInt(count);
  const remainder = total%BigInt(count);
  return Array.from({length:count},(_,index)=>base+(BigInt(index)<remainder?1n:0n));
}

export interface ScheduledInstallment { number:number; periodStart:string; dueDate:string; principal:string; interest:string; total:string }
export function buildTraditionalSchedule(principalCents:bigint, rateUnits:bigint, count:number, frequency:Frequency, firstDueDate:string, startDate:string):ScheduledInstallment[] {
  const principals = distributeCents(principalCents,count);
  const dueDay = Number(firstDueDate.slice(8,10));
  const schedule:ScheduledInstallment[]=[];
  let periodStart=startDate;
  let dueDate=firstDueDate;
  for(let index=0;index<count;index+=1){
    const periodDays=dayDifference(periodStart,dueDate);
    const interest=calculatePeriodInterest(principalCents,rateUnits,periodDays,frequency);
    schedule.push({number:index+1,periodStart,dueDate,principal:centsToAmount(principals[index]),interest:centsToAmount(interest),total:centsToAmount(principals[index]+interest)});
    periodStart=dueDate;
    dueDate=nextDate(dueDate,dueDay,frequency);
  }
  return schedule;
}
