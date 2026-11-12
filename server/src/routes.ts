import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { ResultSetHeader } from 'mysql2';
import { pool, pingDatabase } from './db/pool.js';
import { authenticate, authorize, clearSessionCookieOptions, issueSession, sessionCookieOptions, SESSION_COOKIE, type UserRole } from './auth.js';
import { businessDate, buildTraditionalSchedule, calculateMonthlyInterest, centsToAmount, dateOnly, dayDifference, isCalendarDate, rateToUnits, toCents, type Frequency } from './finance.js';
import { calculatePeriodicPayoffOptions, planPayment, type CurrentCycleInterestOption, type InstallmentBalance, type PaymentMode } from './payment-plan.js';
import { runAccrualCycleForLoan } from './accrual.js';
import { checkLoginThrottle, clearLoginFailures, recordLoginAttempt } from './login-throttle.js';
import { clientImportHeaderMap, documentKey, parseCsvDocument } from './client-import.js';
import { decryptDocument, documentSha256, encryptDocument } from './document-crypto.js';

const loginSchema = z.object({ email: z.string().email().max(190), password: z.string().min(1).max(200) });
const clientSchema = z.object({ firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().min(1).max(120), documentType: z.string().trim().min(1).max(40), documentNumber: z.string().trim().min(1).max(60), phone: z.string().trim().min(1).max(40), countryCode:z.enum(['DO','ES','US','OT']).default('DO'), email: z.union([z.string().email().max(190), z.literal('')]).optional(), address: z.string().max(500).optional() });
const clientProfileSchema = z.object({ birthDate:z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/),z.literal('')]).optional(), guarantorClientId:z.union([z.coerce.number().int().positive(),z.null()]).optional() });
const clientUpdateSchema = clientSchema.extend({ birthDate:z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/),z.literal('')]).optional(), status:z.enum(['active','inactive']).default('active') });
const clientGuaranteeSchema=z.object({guaranteeType:z.string().trim().min(2).max(80),description:z.string().trim().min(2).max(1000),estimatedValue:z.union([z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),z.literal('')]).optional(),loanId:z.union([z.coerce.number().int().positive(),z.null()]).optional(),notes:z.string().trim().max(1000).optional()});
const amountSchema = z.object({ amount: z.coerce.number().positive().max(999999999999), description: z.string().trim().min(2).max(500) });
const expenseSchema = z.object({ amount: z.coerce.number().positive().max(999999999999), category: z.string().trim().min(1).max(100), description: z.string().trim().min(2).max(500), spentAt: z.string().datetime().optional() });
const preferenceSchema = z.object({ language: z.enum(['es','en','fr']).optional(), theme: z.enum(['dark','light']).optional() }).refine((value) => value.language !== undefined || value.theme !== undefined);
const isValidTimezone=(value:string)=>{try{new Intl.DateTimeFormat('en-US',{timeZone:value});return true;}catch{return false;}};
const companySchema = z.object({ companyName: z.string().trim().min(2).max(160), currency: z.enum(['DOP','USD','EUR']), locale: z.enum(['es','en','fr']), timezone: z.string().min(1).max(80).refine(isValidTimezone,'Zona horaria inválida'), graceDaysDefault: z.coerce.number().int().min(0).max(365) });
const userSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(190), password: z.string().min(12).max(200), role: z.enum(['admin','supervisor','collector']), language: z.enum(['es','en','fr']).default('es') });
const loanSchema = z.object({ clientId: z.coerce.number().int().positive(), product: z.enum(['traditional','periodic_interest','fixed_periodic_interest']), principal: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/), monthlyRate: z.string().regex(/^\d{1,3}(?:\.\d{1,5})?$/), installmentCount: z.coerce.number().int().min(1).max(120).optional(), frequency: z.enum(['day','week','fortnight','month']).optional(), firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), graceDays: z.coerce.number().int().min(0).max(365), notes: z.string().trim().max(1000).optional() });
const paymentPreviewSchema=z.object({mode:z.enum(['amount','installments','payoff']),amount:z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).optional(),installmentCount:z.coerce.number().int().min(1).max(120).optional(),currentCycleInterestOption:z.enum(['exact_days','fifteen_days','full_month']).optional()}).superRefine((value,context)=>{if(value.mode==='amount'&&!value.amount)context.addIssue({code:'custom',path:['amount'],message:'Amount is required'});if(value.mode==='installments'&&!value.installmentCount)context.addIssue({code:'custom',path:['installmentCount'],message:'Installment count is required'});});
const paymentSchema=paymentPreviewSchema.extend({paymentMethod:z.enum(['cash','bank_transfer','card','check','other']),reference:z.string().trim().max(120).optional(),notes:z.string().trim().max(500).optional()});
const adjustmentSchema=z.object({reason:z.string().trim().min(5).max(500)});
const loanCancelSchema=z.object({reason:z.string().trim().min(5).max(500),capitalReturned:z.literal(true)});
const clientImportSchema=z.object({csv:z.string().min(1).max(900_000)});
const clientCreateSchema=clientSchema.extend({documents:z.array(z.object({side:z.enum(['front','back']),fileName:z.string().trim().min(1).max(180),dataUrl:z.string().min(40).max(7_500_000)})).max(2).optional()}).superRefine((value,context)=>{const sides=value.documents?.map((item)=>item.side)??[];if(new Set(sides).size!==sides.length)context.addIssue({code:'custom',path:['documents'],message:'Each document side can only be uploaded once.'});});

/**
 * Hash señuelo (coste 12, el mismo que usa el alta de usuarios) contra el que
 * se compara cuando el correo no existe. Igualar el trabajo criptográfico evita
 * que el tiempo de respuesta revele qué correos están dados de alta.
 */
const DUMMY_PASSWORD_HASH = '$2b$12$dlBZG3ndmlUViTLecnq0WeBiya3f3ECfyrTATpdBs984KP1awJnD.';

/** Analiza una IPv6 textual (admite la forma comprimida con `::`). */
function parseIpv6(value: string): Buffer | null {
  const [headPart, tailPart] = value.split('::');
  const head = headPart ? headPart.split(':') : [];
  const tail = tailPart ? tailPart.split(':') : [];
  if (!value.includes('::') && head.length !== 8) return null;
  const missing = 8 - (head.length + tail.length);
  if (value.includes('::') && missing < 1) return null;
  const groups = [...head, ...Array<string>(Math.max(0, missing)).fill('0'), ...tail];
  const buffer = Buffer.alloc(16);
  for (let index = 0; index < 8; index += 1) {
    const group = Number.parseInt(groups[index] ?? '0', 16);
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return null;
    buffer.writeUInt16BE(group, index * 2);
  }
  return buffer;
}

/** Convierte una IP textual al formato binario de `audit_events.ip_address`. */
function toIpBytes(ip: string | undefined): Buffer | null {
  if (!ip) return null;
  const value = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const buffer = Buffer.alloc(16);
    buffer[10] = 0xff;
    buffer[11] = 0xff;
    octets.forEach((octet, index) => {
      buffer[12 + index] = octet;
    });
    return buffer;
  }
  return parseIpv6(value);
}

interface ImportedClient { firstName:string;lastName:string;documentType:string;documentNumber:string;phone:string;countryCode:'DO'|'ES'|'US'|'OT';email:string|null;address:string|null;status:'active'|'inactive' }interface ClientImportResult { total:number;valid:number;duplicates:number;invalid:number;items:Array<{line:number;status:'ready'|'duplicate'|'invalid';message?:string;client?:ImportedClient}> }

function decodeClientImage(dataUrl:string):{mimeType:'image/jpeg'|'image/png'|'image/webp';content:Buffer}{
  const match=dataUrl.match(/^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/]+={0,2})$/);if(!match)throw new Error('Las imágenes deben ser JPEG, PNG o WebP.');
  const mimeType=match[1] as 'image/jpeg'|'image/png'|'image/webp';const content=Buffer.from(match[2],'base64');if(!content.length||content.length>5*1024*1024)throw new Error('Cada imagen debe pesar como máximo 5 MB.');
  const isJpeg=mimeType==='image/jpeg'&&content[0]===0xff&&content[1]===0xd8&&content[2]===0xff;
  const isPng=mimeType==='image/png'&&content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isWebp=mimeType==='image/webp'&&content.toString('ascii',0,4)==='RIFF'&&content.toString('ascii',8,12)==='WEBP';
  if(!(isJpeg||isPng||isWebp))throw new Error('El archivo no coincide con el formato de imagen indicado.');
  return {mimeType,content};
}

async function analyzeClientCsv(csv:string,connection?:Awaited<ReturnType<typeof pool.getConnection>>):Promise<ClientImportResult>{
  const document=parseCsvDocument(csv);if(document.records.length>500)throw new Error('El archivo supera el máximo de 500 clientes por importación.');
  const columns=clientImportHeaderMap(document.headers);const required=['firstName','lastName','documentType','documentNumber','phone'];const missing=required.filter((field)=>columns[field]===undefined);
  if(missing.length){const labels:Record<string,string>={firstName:'nombre',lastName:'apellidos',documentType:'tipo_documento',documentNumber:'identificacion',phone:'telefono'};throw new Error(`Faltan columnas requeridas: ${missing.map((field)=>labels[field]).join(', ')}. Usa nombre, apellidos, tipo_documento, identificacion y telefono.`);}
  const existingRows=connection?await connection.query('SELECT document_type,document_number FROM clients'):await pool.query('SELECT document_type,document_number FROM clients');
  const existing=new Set((existingRows[0] as Array<{document_type:string;document_number:string}>).map((row)=>documentKey(row.document_type,row.document_number)));
  const seen=new Set<string>();const items:ClientImportResult['items']=[];let valid=0,duplicates=0,invalid=0;
  for(const record of document.records){
    const value=(field:string)=>record.values[columns[field]]?.trim()??'';
    const parsed=clientSchema.safeParse({firstName:value('firstName'),lastName:value('lastName'),documentType:value('documentType'),documentNumber:value('documentNumber'),phone:value('phone'),email:value('email'),address:value('address')});
    if(!parsed.success){invalid+=1;items.push({line:record.line,status:'invalid',message:'Faltan datos obligatorios o algún campo supera el límite permitido.'});continue;}
    const key=documentKey(parsed.data.documentType,parsed.data.documentNumber);
    if(existing.has(key)||seen.has(key)){duplicates+=1;items.push({line:record.line,status:'duplicate',message:'El documento ya existe en la nueva base o está repetido en el archivo.'});continue;}
    seen.add(key);const rawStatus=value('status').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const rawCountry=value('countryCode').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();const countryCode:ImportedClient['countryCode']=['do','dominican republic','republica dominicana'].includes(rawCountry)?'DO':['es','espana','spain'].includes(rawCountry)?'ES':['us','usa','united states','estados unidos'].includes(rawCountry)?'US':'OT';
    const client:ImportedClient={...parsed.data,countryCode,email:parsed.data.email||null,address:parsed.data.address||null,status:['0','inactivo','inactive','false','no'].includes(rawStatus)?'inactive':'active'};
    valid+=1;items.push({line:record.line,status:'ready',client});
  }
  return {total:document.records.length,valid,duplicates,invalid,items};
}

async function getPaymentBalances(connection:Awaited<ReturnType<typeof pool.getConnection>>,loanId:string):Promise<InstallmentBalance[]> {
  const [installmentRows]=await connection.execute('SELECT id,installment_number,period_start,due_date,status,principal_due,principal_paid,interest_target,interest_accrued,interest_paid,late_interest_accrued,penalty_accrued FROM installments WHERE loan_id=? ORDER BY due_date,installment_number FOR UPDATE',[loanId]);
  const [allocationRows]=await connection.execute("SELECT a.installment_id,a.component,SUM(a.amount) AS amount FROM payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.status='posted' JOIN installments i ON i.id=a.installment_id WHERE i.loan_id=? AND a.component IN ('late_interest','penalty') GROUP BY a.installment_id,a.component",[loanId]);
  const allocations=new Map<string,{late:string;penalty:string}>();
  for(const item of allocationRows as Array<{installment_id:string;component:string;amount:string}>){
    const entry=allocations.get(String(item.installment_id))??{late:'0.00',penalty:'0.00'};
    if(item.component==='late_interest')entry.late=item.amount;else entry.penalty=item.amount;
    allocations.set(String(item.installment_id),entry);
  }
  return (installmentRows as Array<Record<string,unknown>>).map((row)=>{
    const paid=allocations.get(String(row.id))??{late:'0.00',penalty:'0.00'};
    const periodStart=dateOnly(row.period_start as string|Date);const dueDate=dateOnly(row.due_date as string|Date);
    return {id:String(row.id),number:Number(row.installment_number),periodStart,daysInCycle:Math.max(1,dayDifference(periodStart,dueDate)),dueDate,status:String(row.status),principalDue:String(row.principal_due),principalPaid:String(row.principal_paid),interestTarget:String(row.interest_target),interestAccrued:String(row.interest_accrued),interestPaid:String(row.interest_paid),lateAccrued:String(row.late_interest_accrued),penaltyAccrued:String(row.penalty_accrued),latePaid:paid.late,penaltyPaid:paid.penalty};
  });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- Salud -------------------------------------------------------------
  // `/live` responde si el proceso está vivo (sin tocar la BD): úsalo para
  // reinicios del orquestador. `/ready` comprueba la BD: úsalo para decidir si
  // se envía tráfico. Mezclarlos hacía que una BD lenta provocara reinicios en
  // cascada de contenedores que estaban perfectamente sanos.
  app.get('/api/health/live', async () => ({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));

  app.get('/api/health/ready', async (_request, reply) => {
    const database = await pingDatabase();
    if (!database.ok) {
      return reply.code(503).send({ status: 'unavailable', database });
    }
    return { status: 'ok', database };
  });

  // Compatibilidad con monitores existentes.
  app.get('/api/health', async (_request, reply) => {
    const database = await pingDatabase();
    if (!database.ok) return reply.code(503).send({ status: 'unavailable', database });
    return { status: 'ok', database: true };
  });

  // Límite propio y mucho más estricto que el global: una IP puede intentar
  // 10 accesos por minuto, pero el throttle por cuenta (más abajo) es el que
  // realmente frena la fuerza bruta dirigida.
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Revisa el correo y la contraseña.' });

    const email = parsed.data.email.toLowerCase();

    // 1) ¿La cuenta está bloqueada temporalmente por intentos fallidos?
    const throttle = await checkLoginThrottle(email);
    if (throttle.blocked) {
      request.log.warn({ email, failures: throttle.failures, ip: request.ip }, 'Acceso bloqueado por throttle.');
      reply.header('Retry-After', String(throttle.retryAfterMinutes * 60));
      return reply.code(429).send({
        error: `Demasiados intentos fallidos. Espera ${throttle.retryAfterMinutes} minutos o restablece la contraseña.`,
      });
    }

    const [rows] = await pool.execute(
      "SELECT id, name, email, password_hash, role, preferred_language, preferred_theme FROM users WHERE email = ? AND status = 'active' LIMIT 1",
      [email],
    );
    const row = (rows as Array<Record<string, string>>)[0];

    // Salvaguarda: si el valor almacenado no es un hash bcrypt (por ejemplo,
    // porque alguien insertó la contraseña en texto plano), `bcrypt.compare`
    // siempre fallará y el usuario vería «contraseña incorrecta» sin ninguna
    // pista. Se deja constancia explícita en el registro del servidor.
    if (row && !/^\$2[aby]\$\d{2}\$/.test(row.password_hash)) {
      request.log.error(
        { userId: row.id },
        'El hash de contraseña almacenado no es bcrypt válido. Restablece la contraseña con `npm run db:reset-admin-password`.',
      );
    }

    // Se compara siempre contra un hash (real o señuelo) para no revelar por
    // tiempo de respuesta si el correo existe.
    const passwordMatches = await bcrypt.compare(parsed.data.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);

    if (!row || !passwordMatches) {
      await recordLoginAttempt({ email, ip: request.ip, succeeded: false });
      // Auditoría del fallo: sin esto no se puede detectar un ataque en curso.
      await pool.execute(
        "INSERT INTO audit_events (actor_id, action, entity_type, entity_id, request_id, after_data, ip_address) VALUES (NULL,'auth.login_failed','user',NULL,?,?,?)",
        [request.id, JSON.stringify({ email, reason: row ? 'bad_password' : 'unknown_user' }), toIpBytes(request.ip)],
      ).catch(() => undefined);
      return reply.code(401).send({ error: 'Correo o contraseña incorrectos.' });
    }

    const user = { id: String(row.id), name: row.name, email: row.email, role: row.role as UserRole, language: row.preferred_language as 'es'|'en'|'fr', theme: (row.preferred_theme === 'light' ? 'light' : 'dark') as 'dark'|'light' };
    const token = await issueSession(user);
    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    await recordLoginAttempt({ email, ip: request.ip, succeeded: true });
    await clearLoginFailures(email);
    await pool.execute('INSERT INTO audit_events (actor_id, action, entity_type, entity_id, request_id, ip_address) VALUES (?, ?, ?, ?, ?, ?)', [user.id, 'auth.login', 'user', user.id, request.id, toIpBytes(request.ip)]);
    return { user };
  });

  app.post('/api/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    if (request.user) await pool.execute('INSERT INTO audit_events (actor_id, action, entity_type, entity_id, request_id) VALUES (?, ?, ?, ?, ?)', [request.user.id, 'auth.logout', 'user', request.user.id, request.id]);
    reply.clearCookie(SESSION_COOKIE, clearSessionCookieOptions());
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => ({ user: request.user }));

  app.patch('/api/auth/preferences', { preHandler: authenticate }, async (request, reply) => {
    const parsed = preferenceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Selecciona preferencias válidas.' });
    const language = parsed.data.language ?? request.user!.language;
    const theme = parsed.data.theme ?? request.user!.theme;
    await pool.execute('UPDATE users SET preferred_language=?,preferred_theme=? WHERE id=?', [language, theme, request.user!.id]);
    const user = { ...request.user!, language, theme };
    reply.setCookie(SESSION_COOKIE, await issueSession(user), sessionCookieOptions());
    await pool.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)', [user.id,'user.preferences_change','user',user.id,request.id,JSON.stringify({language,theme})]);
    return { user };
  });

  app.get('/api/settings', { preHandler: authenticate }, async () => {
    const [rows] = await pool.query('SELECT company_name AS companyName, currency, locale, timezone, grace_days_default AS graceDaysDefault FROM company_settings WHERE id = 1');
    return (rows as unknown[])[0] ?? null;
  });

  app.get('/api/users', { preHandler: [authenticate, async (request, reply) => authorize(['admin'], request, reply)] }, async () => {
    const [rows] = await pool.query("SELECT id,name,email,role,status,preferred_language AS language,created_at AS createdAt FROM users ORDER BY created_at ASC,id ASC");
    return rows;
  });

  app.post('/api/users', { preHandler: [authenticate, async (request, reply) => authorize(['admin'], request, reply)] }, async (request, reply) => {
    const parsed = userSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Revisa nombre, correo, rol y contraseña. La contraseña debe tener al menos 12 caracteres.' });
    const connection = await pool.getConnection();
    try {
      const hash = await bcrypt.hash(parsed.data.password, 12);
      await connection.beginTransaction();
      const [result] = await connection.execute('INSERT INTO users (name,email,password_hash,role,preferred_language) VALUES (?,?,?,?,?)', [parsed.data.name,parsed.data.email.toLowerCase(),hash,parsed.data.role,parsed.data.language]);
      const id = String((result as ResultSetHeader).insertId);
      await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)', [request.user!.id,'user.create','user',id,request.id,JSON.stringify({name:parsed.data.name,email:parsed.data.email,role:parsed.data.role,language:parsed.data.language})]);
      await connection.commit();
      return reply.code(201).send({ id, name:parsed.data.name,email:parsed.data.email,role:parsed.data.role,status:'active',language:parsed.data.language });
    } catch (error) {
      await connection.rollback();
      if ((error as {code?:string}).code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'Ya existe una cuenta con ese correo.' });
      throw error;
    } finally { connection.release(); }
  });

  app.get('/api/loans', { preHandler: authenticate }, async (request) => {
    const query = z.object({ status: z.enum(['active','paused','paid','cancelled','all']).default('all'), search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset:z.coerce.number().int().min(0).max(10_000_000).default(0) }).safeParse(request.query);
    if (!query.success) return { items: [], total: 0 };
    const status = query.data.status;
    const pattern = `%${query.data.search?.trim() ?? ''}%`;
    const [[countRows],[rows]] = await Promise.all([
      pool.execute("SELECT COUNT(*) AS total FROM loans l JOIN clients c ON c.id=l.client_id WHERE (?='all' OR l.status=?) AND (?='%%' OR CONCAT(c.first_name,' ',c.last_name,' ',c.document_number) LIKE ?)",[status,status,pattern,pattern]),
      pool.execute("SELECT l.id,l.product,l.principal,l.principal_outstanding,l.interest_rate AS monthlyRate,l.status,DATE_FORMAT(l.first_due_date,'%Y-%m-%d') AS firstDueDate,l.grace_days AS graceDays,l.currency,l.created_at AS createdAt,c.first_name AS firstName,c.last_name AS lastName,c.document_number AS documentNumber,(SELECT COUNT(*) FROM installments i WHERE i.loan_id=l.id) AS installmentCount,(SELECT COALESCE(SUM(i.interest_accrued-i.interest_paid+i.late_interest_accrued+i.penalty_accrued),0) FROM installments i WHERE i.loan_id=l.id AND i.status IN ('open','due','overdue')) AS incomePending FROM loans l JOIN clients c ON c.id=l.client_id WHERE (?='all' OR l.status=?) AND (?='%%' OR CONCAT(c.first_name,' ',c.last_name,' ',c.document_number) LIKE ?) ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?", [status,status,pattern,pattern,query.data.limit,query.data.offset]),
    ]);
    return { items: rows, total:Number((countRows as Array<{total:number}>)[0]?.total??0) };
  });

  app.get('/api/loans/:id', { preHandler: authenticate }, async (request, reply) => {
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);
    if(!params.success)return reply.code(400).send({error:'El préstamo indicado no es válido.'});
    await runAccrualCycleForLoan(String(params.data.id));
    const connection=await pool.getConnection();
    try {
      const [loanRows]=await connection.execute("SELECT l.id,l.client_id AS clientId,l.product,l.principal,l.principal_outstanding AS principalOutstanding,l.interest_rate AS monthlyRate,l.interest_period AS interestPeriod,l.installment_count AS installmentCount,l.installment_frequency AS frequency,l.grace_days AS graceDays,l.status,l.first_due_date AS firstDueDate,l.due_day AS dueDay,l.paused_days AS pausedDays,l.notes,l.currency,l.created_at AS createdAt,c.first_name AS firstName,c.last_name AS lastName,c.document_type AS documentType,c.document_number AS documentNumber,c.phone,c.email,c.address FROM loans l JOIN clients c ON c.id=l.client_id WHERE l.id=? LIMIT 1",[params.data.id]);
      const loan=(loanRows as Array<Record<string,unknown>>)[0];
      if(!loan)return reply.code(404).send({error:'No se encontró el préstamo.'});
      const installments=await getPaymentBalances(connection,String(loan.id));
      const loanId=String(loan.id);
      const [paidRows]=await connection.execute("SELECT COALESCE(SUM(p.amount),0) AS paid,COUNT(*) AS paymentCount FROM payments p WHERE p.loan_id=? AND p.status='posted'",[loanId]);
      const [paymentRows]=await connection.execute("SELECT p.id,p.amount,DATE_FORMAT(p.paid_at,'%Y-%m-%d %H:%i:%s') AS paidAt,p.payment_method AS paymentMethod,p.reference,p.kind,u.name AS receivedBy,cm.description FROM payments p JOIN users u ON u.id=p.received_by LEFT JOIN cash_movements cm ON cm.reference_type='payment' AND cm.reference_id=p.id WHERE p.loan_id=? AND p.status='posted' ORDER BY p.paid_at DESC,p.id DESC LIMIT 100",[loanId]);
      const [allocRows]=await connection.execute("SELECT a.payment_id AS paymentId, a.component, SUM(a.amount) AS amount FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.loan_id=? AND p.status='posted' GROUP BY a.payment_id, a.component",[loanId]);
      const allocMap=new Map<string,{capital:string;currentInterest:string;lateInterest:string;penalty:string}>();
      for(const row of allocRows as Array<{paymentId:number|string;component:string;amount:string}>){
        const pid=String(row.paymentId);
        const entry=allocMap.get(pid)??{capital:'0.00',currentInterest:'0.00',lateInterest:'0.00',penalty:'0.00'};
        if(row.component==='principal')entry.capital=row.amount;
        else if(row.component==='current_interest')entry.currentInterest=row.amount;
        else if(row.component==='late_interest')entry.lateInterest=row.amount;
        else if(row.component==='penalty')entry.penalty=row.amount;
        allocMap.set(pid,entry);
      }
      const enrichedPayments=(paymentRows as Array<Record<string,unknown>>).map(p=>({
        ...p,
        id:String(p.id),
        description:p.description?String(p.description):undefined,
        breakdown:allocMap.get(String(p.id))??{capital:'0.00',currentInterest:'0.00',lateInterest:'0.00',penalty:'0.00'}
      }));
      const totalPaid=String((paidRows as Array<{paid:string}>)[0]?.paid??'0.00');
      return {loan:{...loan,id:String(loan.id),firstDueDate:dateOnly(loan.firstDueDate as string|Date),createdAt:loan.createdAt},installments,payments:enrichedPayments,totalPaid};
    } finally { connection.release(); }
  });

  app.post('/api/loans/preview', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request, reply) => {
    const parsed=loanSchema.safeParse(request.body);
    if(!parsed.success) return reply.code(400).send({error:'Completa las condiciones del préstamo para simularlo.'});
    const data=parsed.data;
    if(!isCalendarDate(data.firstDueDate)) return reply.code(400).send({error:'La fecha de vencimiento no es válida.'});
    if(data.product==='traditional'&&!data.installmentCount) return reply.code(400).send({error:'Indica cuántas cuotas tendrá el préstamo tradicional.'});
    const principal=toCents(data.principal);const rate=rateToUnits(data.monthlyRate);
    if(principal<=0n||rate<=0n) return reply.code(400).send({error:'El capital y la tasa deben ser mayores que cero.'});
    const [settingsRows]=await pool.query('SELECT timezone,currency FROM company_settings WHERE id=1');
    const settings=(settingsRows as Array<{timezone:string;currency:string}>)[0];
    if(!settings) return reply.code(409).send({error:'Primero configura la empresa.'});
    const today=businessDate(settings.timezone);
    if(data.firstDueDate<=today) return reply.code(400).send({error:'La primera fecha de vencimiento debe ser posterior a hoy.'});
    const frequency:Frequency=data.product==='traditional'?data.frequency??'month':'month';
    const schedule=data.product==='traditional'
      ?buildTraditionalSchedule(principal,rate,data.installmentCount!,frequency,data.firstDueDate,today)
      :[{number:1,periodStart:today,dueDate:data.firstDueDate,principal:'0.00',interest:centsToAmount(calculateMonthlyInterest(principal,rate)),total:centsToAmount(calculateMonthlyInterest(principal,rate))}];
    const totalPrincipal=schedule.reduce((sum,item)=>sum+toCents(item.principal),0n);
    const totalInterest=schedule.reduce((sum,item)=>sum+toCents(item.interest),0n);
    const total=totalPrincipal+totalInterest;
    return {currency:settings.currency,product:data.product,monthlyRate:Number(data.monthlyRate),principal:centsToAmount(principal),installmentCount:schedule.length,frequency,graceDays:data.graceDays,firstDueDate:data.firstDueDate,lastDueDate:schedule.at(-1)?.dueDate,totalPrincipal:centsToAmount(totalPrincipal),totalInterest:centsToAmount(totalInterest),totalToPay:centsToAmount(total),schedule};
  });

  app.post('/api/loans', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request, reply) => {
    const parsed = loanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Completa los datos del préstamo y revisa la simulación.' });
    const data = parsed.data;
    const frequency: Frequency = data.product === 'traditional' ? data.frequency ?? 'month' : 'month';
    if (data.product === 'traditional' && !data.installmentCount) return reply.code(400).send({ error: 'Indica cuántas cuotas tendrá el préstamo tradicional.' });
    const principalCents = toCents(data.principal);
    const rateUnits = rateToUnits(data.monthlyRate);
    if (principalCents <= 0n || rateUnits <= 0n) return reply.code(400).send({ error: 'El capital y la tasa deben ser mayores que cero.' });
    if (!isCalendarDate(data.firstDueDate)) return reply.code(400).send({error:'La fecha de vencimiento no es válida.'});
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [settingsRows] = await connection.query('SELECT currency,timezone FROM company_settings WHERE id=1 FOR UPDATE');
      const settings = (settingsRows as Array<{currency:string;timezone:string}>)[0];
      if (!settings) throw new Error('Primero configura la empresa.');
      if (data.firstDueDate <= businessDate(settings.timezone)) {
        await connection.rollback();
        return reply.code(400).send({ error: 'La primera fecha de vencimiento debe ser posterior a hoy.' });
      }
      const [cashRows] = await connection.query("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS available FROM cash_movements");
      const available = toCents(String((cashRows as Array<{available:string}>)[0].available));
      if (available < principalCents) {
        await connection.rollback();
        return reply.code(409).send({ error: 'El capital disponible en Banki no cubre el monto solicitado.' });
      }
      const [clientRows] = await connection.execute("SELECT id FROM clients WHERE id=? AND status='active' FOR UPDATE", [data.clientId]);
      if (!(clientRows as unknown[]).length) {
        await connection.rollback();
        return reply.code(404).send({ error: 'El cliente no existe o está inactivo.' });
      }
      const rate = Number(data.monthlyRate).toFixed(5);
      const [loanResult] = await connection.execute("INSERT INTO loans (client_id,product,principal,principal_outstanding,interest_rate,interest_period,installment_count,installment_frequency,due_day,grace_days,late_interest_rate,notes,status,first_due_date,currency,approved_by,created_by) VALUES (?,?,?,?,?,'month',?,?,?,?,?,?,'active',?,?,?,?)", [data.clientId,data.product,centsToAmount(principalCents),centsToAmount(principalCents),rate,data.product==='traditional'?data.installmentCount!:null,data.product==='traditional'?frequency:null,Number(data.firstDueDate.slice(8,10)),data.graceDays,rate,data.notes||null,data.firstDueDate,settings.currency,request.user!.id,request.user!.id]);
      const loanId = String((loanResult as ResultSetHeader).insertId);
      const today = businessDate(settings.timezone);
      if (data.product === 'traditional') {
        const count = data.installmentCount!;
        const schedule=buildTraditionalSchedule(principalCents,rateUnits,count,frequency,data.firstDueDate,today);
        for (const installment of schedule) await connection.execute("INSERT INTO installments (loan_id,installment_number,period_start,due_date,principal_due,interest_target,interest_accrued,status) VALUES (?,?,?,?,?,?,?,'scheduled')", [loanId,installment.number,installment.periodStart,installment.dueDate,installment.principal,installment.interest,installment.interest]);
      } else {
        const monthlyInterest = calculateMonthlyInterest(principalCents,rateUnits);
        await connection.execute("INSERT INTO installments (loan_id,installment_number,period_start,due_date,principal_due,interest_target,interest_accrued,status) VALUES (?,?,?,?,0,?,0,'open')", [loanId,1,today,data.firstDueDate,centsToAmount(monthlyInterest)]);
      }
      await connection.execute("INSERT INTO cash_movements (movement_type,direction,amount,capital_component,reference_type,reference_id,description,occurred_at,recorded_by) VALUES ('loan_disbursement','out',?,?,'loan',?,?,NOW(),?)", [centsToAmount(principalCents),centsToAmount(principalCents),loanId,`Préstamo #${loanId} otorgado`,request.user!.id]);
      await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)', [request.user!.id,'loan.create','loan',loanId,request.id,JSON.stringify({ clientId:data.clientId,product:data.product,principal:data.principal,monthlyRate:data.monthlyRate,installmentCount:data.installmentCount??null,frequency,firstDueDate:data.firstDueDate,graceDays:data.graceDays,notes:data.notes??'' })]);
      await connection.commit();
      return reply.code(201).send({ id:loanId,status:'active',product:data.product,principal:data.principal,currency:settings.currency,installments:data.product==='traditional'?data.installmentCount:1 });
    } catch (error) { await connection.rollback(); if ((error as {code?:string}).code==='ER_DUP_ENTRY') return reply.code(409).send({error:'No se pudo guardar el préstamo por una condición duplicada.'}); throw error; }
    finally { connection.release(); }
  });

  app.post('/api/loans/:id/cancel', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request, reply) => {
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);
    const parsed=loanCancelSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'Indica el motivo y confirma que el capital fue devuelto a caja.'});
    await runAccrualCycleForLoan(String(params.data.id));
    const connection=await pool.getConnection();
    try{
      await connection.beginTransaction();
      const [settingsRows]=await connection.query('SELECT timezone FROM company_settings WHERE id=1 FOR UPDATE');
      const today=businessDate((settingsRows as Array<{timezone:string}>)[0]?.timezone??'America/Santo_Domingo');
      const [loanRows]=await connection.execute('SELECT id,product,status,principal,principal_outstanding,currency FROM loans WHERE id=? FOR UPDATE',[params.data.id]);
      const loan=(loanRows as Array<{id:number;product:string;status:string;principal:string;principal_outstanding:string;currency:string}>)[0];
      if(!loan){await connection.rollback();return reply.code(404).send({error:'No se encontró el préstamo.'});}
      if(!['active','paused'].includes(loan.status)){await connection.rollback();return reply.code(409).send({error:'Solo se puede anular un préstamo activo o en pausa.'});}
      const [paymentRows]=await connection.execute('SELECT COUNT(*) AS total FROM payments WHERE loan_id=?',[loan.id]);
      if(Number((paymentRows as Array<{total:number}>)[0].total)>0){await connection.rollback();return reply.code(409).send({error:'No se puede anular un préstamo con pagos registrados.'});}
      const [installmentRows]=await connection.execute('SELECT id,installment_number,period_start,due_date,principal_due,interest_target,interest_accrued,late_interest_accrued,penalty_accrued,status FROM installments WHERE loan_id=? ORDER BY installment_number FOR UPDATE',[loan.id]);
      const installments=installmentRows as Array<Record<string,unknown>>;
      if(installments.some(item=>dateOnly(item.due_date as string|Date)<=today)){await connection.rollback();return reply.code(409).send({error:'No se puede anular porque ya existe una cuota vencida.'});}
      const principal=toCents(loan.principal_outstanding);
      if(principal<=0n){await connection.rollback();return reply.code(409).send({error:'No hay capital pendiente que devolver a caja.'});}
      const [disbursementRows]=await connection.execute("SELECT id FROM cash_movements WHERE movement_type='loan_disbursement' AND reference_type='loan' AND reference_id=? ORDER BY id LIMIT 1 FOR UPDATE",[loan.id]);
      const disbursement=(disbursementRows as Array<{id:number}>)[0];
      if(!disbursement){await connection.rollback();return reply.code(409).send({error:'No se encontró el desembolso original para vincular su reverso.'});}
      await connection.execute("INSERT INTO cash_movements (movement_type,direction,amount,capital_component,reference_type,reference_id,description,occurred_at,recorded_by,reversal_of) VALUES ('loan_cancellation','in',?,?,'loan',?,?,NOW(),?,?)",[centsToAmount(principal),centsToAmount(principal),loan.id,`Devolución de capital · anulación préstamo #${loan.id}`,request.user!.id,disbursement.id]);
      await connection.execute("UPDATE installments SET interest_accrued=0,late_interest_accrued=0,penalty_accrued=0,status='waived',closed_at=NOW() WHERE loan_id=?",[loan.id]);
      await connection.execute("UPDATE loans SET principal_outstanding=0,status='cancelled' WHERE id=?",[loan.id]);
      const before={status:loan.status,principal:loan.principal,principalOutstanding:loan.principal_outstanding,currency:loan.currency,installments};
      const after={status:'cancelled',principalReturned:centsToAmount(principal),currency:loan.currency,reason:parsed.data.reason};
      await connection.execute("INSERT INTO loan_adjustments (loan_id,action,reason,before_data,after_data,created_by,approved_by) VALUES (?,'cancel',?,?,?,?,?)",[loan.id,parsed.data.reason,JSON.stringify(before),JSON.stringify(after),request.user!.id,request.user!.id]);
      await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,before_data,after_data) VALUES (?,'loan.cancel','loan',?,?,?,?)",[request.user!.id,loan.id,request.id,JSON.stringify(before),JSON.stringify(after)]);
      await connection.commit();
      return {id:String(loan.id),status:'cancelled',capitalReturned:centsToAmount(principal),currency:loan.currency};
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.patch('/api/loans/:id', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request, reply) => {
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);
    const parsed=loanSchema.extend({product:z.literal('traditional'),reason:z.string().trim().min(5).max(500)}).safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'Revisa las condiciones y el motivo del cambio.'});
    const data=parsed.data;
    if(!data.installmentCount||!isCalendarDate(data.firstDueDate))return reply.code(400).send({error:'La cantidad de cuotas y la fecha no son válidas.'});
    const principal=toCents(data.principal);const rate=rateToUnits(data.monthlyRate);
    if(principal<=0n||rate<=0n)return reply.code(400).send({error:'El capital y la tasa deben ser mayores que cero.'});
    const connection=await pool.getConnection();
    try{
      await connection.beginTransaction();
      const [settingsRows]=await connection.query('SELECT timezone,currency FROM company_settings WHERE id=1 FOR UPDATE');
      const settings=(settingsRows as Array<{timezone:string;currency:string}>)[0];
      if(!settings){await connection.rollback();return reply.code(409).send({error:'Primero configura la empresa.'});}
      const today=businessDate(settings.timezone);
      if(data.firstDueDate<=today){await connection.rollback();return reply.code(400).send({error:'La nueva primera fecha de vencimiento debe ser posterior a hoy.'});}
      const [loanRows]=await connection.execute('SELECT id,client_id AS clientId,product,status,principal,interest_rate AS monthlyRate,installment_count AS installmentCount,installment_frequency AS frequency,grace_days AS graceDays,first_due_date AS firstDueDate,notes FROM loans WHERE id=? FOR UPDATE',[params.data.id]);
      const loan=(loanRows as Array<{id:number;clientId:number;product:string;status:string;principal:string;monthlyRate:string;installmentCount:number|null;frequency:Frequency|null;graceDays:number;firstDueDate:string|Date;notes:string|null}>)[0];
      if(!loan){await connection.rollback();return reply.code(404).send({error:'No se encontró el préstamo.'});}
      if(loan.product!=='traditional'||loan.status!=='active'||dateOnly(loan.firstDueDate)<=today){await connection.rollback();return reply.code(409).send({error:'Solo se puede editar un préstamo tradicional activo antes del primer vencimiento.'});}
      const [paymentRows]=await connection.execute('SELECT COUNT(*) AS total FROM payments WHERE loan_id=?',[loan.id]);
      if(Number((paymentRows as Array<{total:number}>)[0].total)>0){await connection.rollback();return reply.code(409).send({error:'El préstamo ya tiene pagos y no admite cambios de condiciones.'});}
      const [clientRows]=await connection.execute("SELECT id FROM clients WHERE id=? AND status='active' FOR UPDATE",[data.clientId]);
      if(!(clientRows as unknown[]).length){await connection.rollback();return reply.code(404).send({error:'El cliente no existe o está inactivo.'});}
      const oldPrincipal=toCents(String(loan.principal));const difference=principal-oldPrincipal;
      if(difference>0n){const [cashRows]=await connection.query("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS available FROM cash_movements");const available=toCents(String((cashRows as Array<{available:string}>)[0].available));if(available<difference){await connection.rollback();return reply.code(409).send({error:'La caja no tiene capital suficiente para aumentar el préstamo.'});}}
      const rateText=Number(data.monthlyRate).toFixed(5);const frequency=data.frequency??'month';
      const before={clientId:String(loan.clientId),principal:String(loan.principal),monthlyRate:String(loan.monthlyRate),installmentCount:Number(loan.installmentCount),frequency:loan.frequency,graceDays:Number(loan.graceDays),firstDueDate:dateOnly(loan.firstDueDate),notes:loan.notes};
      await connection.execute('UPDATE loans SET client_id=?,principal=?,principal_outstanding=?,interest_rate=?,installment_count=?,installment_frequency=?,due_day=?,grace_days=?,late_interest_rate=?,notes=?,first_due_date=?,currency=? WHERE id=?',[data.clientId,centsToAmount(principal),centsToAmount(principal),rateText,data.installmentCount,frequency,Number(data.firstDueDate.slice(8,10)),data.graceDays,rateText,data.notes||null,data.firstDueDate,settings.currency,loan.id]);
      await connection.execute('DELETE FROM installments WHERE loan_id=?',[loan.id]);
      const schedule=buildTraditionalSchedule(principal,rateToUnits(rateText),data.installmentCount,frequency,data.firstDueDate,today);
      for(const item of schedule)await connection.execute("INSERT INTO installments (loan_id,installment_number,period_start,due_date,principal_due,interest_target,interest_accrued,status) VALUES (?,?,?,?,?,?,?,'scheduled')",[loan.id,item.number,item.periodStart,item.dueDate,item.principal,item.interest,item.interest]);
      if(difference!==0n){const increase=difference>0n;const amount=centsToAmount(increase?difference:-difference);await connection.execute("INSERT INTO cash_movements (movement_type,direction,amount,capital_component,reference_type,reference_id,description,occurred_at,recorded_by) VALUES ('adjustment',?,?,?,?,? ,?,NOW(),?)",[increase?'out':'in',amount,amount,'loan',loan.id,`Ajuste de desembolso · préstamo #${loan.id}`,request.user!.id]);}
      const after={clientId:data.clientId,principal:centsToAmount(principal),monthlyRate:rateText,installmentCount:data.installmentCount,frequency,graceDays:data.graceDays,firstDueDate:data.firstDueDate,notes:data.notes??''};
      await connection.execute("INSERT INTO loan_adjustments (loan_id,action,reason,before_data,after_data,created_by,approved_by) VALUES (?,'edit',?,?,?,?,?)",[loan.id,data.reason,JSON.stringify(before),JSON.stringify(after),request.user!.id,request.user!.id]);
      await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,before_data,after_data) VALUES (?,'loan.edit','loan',?,?,?,?)",[request.user!.id,loan.id,request.id,JSON.stringify(before),JSON.stringify({...after,reason:data.reason})]);
      await connection.commit();
      return {id:String(loan.id),status:'active',product:'traditional',installments:schedule.length};
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.post('/api/loans/:id/payments/preview', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor','collector'], request, reply)] }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);
    const parsed=paymentPreviewSchema.safeParse(request.body);
    if(!params.success||!parsed.success)return reply.code(400).send({error:'Selecciona una forma de pago válida.'});
    await runAccrualCycleForLoan(String(params.data.id));
    const connection=await pool.getConnection();
    try{
      const [loanRows]=await connection.execute("SELECT id,status,product,principal_outstanding FROM loans WHERE id=?",[params.data.id]);
      const loan=(loanRows as Array<{id:string;status:string;product:string;principal_outstanding:string}>)[0];
      if(!loan)return reply.code(404).send({error:'No se encontró el préstamo.'});
      if(loan.status!=='active')return reply.code(409).send({error:'Este préstamo no acepta pagos en su estado actual.'});
      const balances=await getPaymentBalances(connection,String(loan.id));
      const principalOutstanding=String(loan.principal_outstanding);

      const [settingsRows]=await connection.query('SELECT timezone FROM company_settings WHERE id=1');
      const today=businessDate((settingsRows as Array<{timezone:string}>)[0]?.timezone??'America/Santo_Domingo');

      let payoffOptions=undefined;
      let targetBalances=balances;

      if(parsed.data.mode==='payoff'&&loan.product!=='traditional'){
        const periodicCalculation=calculatePeriodicPayoffOptions(balances,principalOutstanding,today,parsed.data.currentCycleInterestOption);
        if(periodicCalculation){
          payoffOptions=periodicCalculation.payoffOptions;
          targetBalances=periodicCalculation.adjustedBalances;
        }
      }

      const plan=planPayment(targetBalances,parsed.data.mode as PaymentMode,parsed.data.amount,parsed.data.installmentCount,principalOutstanding);
      return {
        loanId:String(loan.id),
        ...plan,
        payoffOptions,
        allocations:plan.allocations.map((allocation)=>({...allocation,installmentNumber:balances.find((item)=>item.id===allocation.installmentId)?.number}))
      };
    }finally{connection.release();}
  });

  app.post('/api/loans/:id/payments', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor','collector'], request, reply)] }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);
    const parsed=paymentSchema.safeParse(request.body);
    const idempotencyKey=z.string().uuid().safeParse(request.headers['idempotency-key']);
    if(!params.success||!parsed.success||!idempotencyKey.success)return reply.code(400).send({error:'La solicitud del pago no es válida. Actualiza la pantalla y vuelve a intentar.'});
    await runAccrualCycleForLoan(String(params.data.id));
    const connection=await pool.getConnection();
    try{
      await connection.beginTransaction();
      await connection.query('SELECT id FROM company_settings WHERE id=1 FOR UPDATE');
      const [priorRows]=await connection.execute('SELECT id,amount,loan_id AS loanId,status FROM payments WHERE idempotency_key=? LIMIT 1',[idempotencyKey.data]);
      const prior=(priorRows as Array<Record<string,string>>)[0];
      if(prior){await connection.rollback();return {id:prior.id,loanId:prior.loanId,amount:prior.amount,status:prior.status,idempotent:true};}
      const [loanRows]=await connection.execute("SELECT l.id,l.client_id AS clientId,l.product,l.status,l.principal_outstanding AS principalOutstanding,l.currency,c.first_name AS firstName,c.last_name AS lastName,c.phone,c.document_type AS documentType,c.document_number AS documentNumber FROM loans l JOIN clients c ON c.id=l.client_id WHERE l.id=? FOR UPDATE",[params.data.id]);
      const loan=(loanRows as Array<Record<string,string>>)[0];
      if(!loan){await connection.rollback();return reply.code(404).send({error:'No se encontró el préstamo.'});}
      if(loan.status!=='active'){await connection.rollback();return reply.code(409).send({error:'Este préstamo no acepta pagos en su estado actual.'});}
      const balances=await getPaymentBalances(connection,String(loan.id));

      const today=businessDate((await connection.query('SELECT timezone FROM company_settings WHERE id=1').then(([rows])=>(rows as Array<{timezone:string}>)[0]))?.timezone??'America/Santo_Domingo');

      let targetBalances=balances;
      let payoffCalculation=null;

      if(parsed.data.mode==='payoff'&&loan.product!=='traditional'){
        payoffCalculation=calculatePeriodicPayoffOptions(balances,loan.principalOutstanding,today,parsed.data.currentCycleInterestOption);
        if(payoffCalculation){
          if(parsed.data.currentCycleInterestOption==='fifteen_days'&&payoffCalculation.elapsedDays>20){
            await connection.rollback();
            return reply.code(400).send({error:'La opción de 15 días no está disponible cuando han transcurrido más de 20 días.'});
          }
          await connection.execute('UPDATE installments SET interest_target=?,interest_accrued=? WHERE id=?',[payoffCalculation.chosenTargetInterest,payoffCalculation.chosenTargetInterest,payoffCalculation.adjustedInstallmentId]);
          targetBalances=payoffCalculation.adjustedBalances;
        }
      }

      const plan=planPayment(targetBalances,parsed.data.mode as PaymentMode,parsed.data.amount,parsed.data.installmentCount,loan.principalOutstanding);
      const currencyComponent=(component:string)=>plan.allocations.filter((item)=>item.component===component).reduce((sum,item)=>sum+toCents(item.amount),0n);
      const capital=currencyComponent('principal');const currentInterest=currencyComponent('current_interest');const lateInterest=currencyComponent('late_interest');const penalty=currencyComponent('penalty');
      const kind=parsed.data.mode==='payoff'?'payoff':parsed.data.mode==='installments'?'bulk':balances.some((item)=>item.dueDate>today)?'advance':'regular';
      const [paymentResult]=await connection.execute('INSERT INTO payments (loan_id,client_id,amount,paid_at,payment_method,reference,kind,status,received_by,idempotency_key) VALUES (?,?,?,NOW(),?,?,?,\'posted\',?,?)',[loan.id,loan.clientId,plan.amount,parsed.data.paymentMethod,parsed.data.reference||null,kind,request.user!.id,idempotencyKey.data]);
      const paymentId=String((paymentResult as ResultSetHeader).insertId);
      for(const item of plan.allocations) await connection.execute('INSERT INTO payment_allocations (payment_id,installment_id,component,amount) VALUES (?,?,?,?)',[paymentId,item.installmentId,item.component,item.amount]);
      const byInstallment=new Map<string,Map<string,bigint>>();
      for(const item of plan.allocations){if(!item.installmentId)continue;const components=byInstallment.get(item.installmentId)??new Map<string,bigint>();components.set(item.component,(components.get(item.component)??0n)+toCents(item.amount));byInstallment.set(item.installmentId,components);}
      for(const [installmentId,components] of byInstallment){
        const principalPart=components.get('principal')??0n;const interestPart=components.get('current_interest')??0n;
        await connection.execute('UPDATE installments SET principal_paid=principal_paid+?,interest_paid=interest_paid+? WHERE id=?',[centsToAmount(principalPart),centsToAmount(interestPart),installmentId]);
      }
      const principalAfter=toCents(loan.principalOutstanding)-capital;
      if(principalAfter<0n)throw new Error('El pago excede el capital pendiente del préstamo.');
      await connection.execute('UPDATE loans SET principal_outstanding=? WHERE id=?',[centsToAmount(principalAfter),loan.id]);

      const movementDescription=payoffCalculation
        ? `Liquidación total (${payoffCalculation.optionLabel}) · préstamo #${loan.id}`
        : `Pago recibido · préstamo #${loan.id}`;

      const [movementResult]=await connection.execute("INSERT INTO cash_movements (movement_type,direction,amount,capital_component,current_interest_component,late_interest_component,penalty_component,reference_type,reference_id,description,occurred_at,recorded_by) VALUES ('payment_received','in',?,?,?,?,?,'payment',?,?,NOW(),?)",[plan.amount,centsToAmount(capital),centsToAmount(currentInterest),centsToAmount(lateInterest),centsToAmount(penalty),paymentId,movementDescription,request.user!.id]);
      const movementId=String((movementResult as ResultSetHeader).insertId);
      const newBalances=await getPaymentBalances(connection,String(loan.id));
      for(const installment of newBalances){
        const stillDue=toCents(installment.principalDue)-toCents(installment.principalPaid)+toCents(installment.interestTarget)-toCents(installment.interestPaid)+toCents(installment.lateAccrued)-toCents(installment.latePaid)+toCents(installment.penaltyAccrued)-toCents(installment.penaltyPaid);
        if(stillDue<=0n&&installment.status!=='paid'&&installment.status!=='waived')await connection.execute("UPDATE installments SET status='paid',closed_at=NOW() WHERE id=?",[installment.id]);
      }
      const remainingTotals=newBalances.reduce((sum,item)=>sum+toCents(item.principalDue)-toCents(item.principalPaid)+toCents(item.interestTarget)-toCents(item.interestPaid)+toCents(item.lateAccrued)-toCents(item.latePaid)+toCents(item.penaltyAccrued)-toCents(item.penaltyPaid),0n);
      if(principalAfter===0n&&remainingTotals<=0n)await connection.execute("UPDATE loans SET status='paid' WHERE id=?",[loan.id]);

      const payoffDetails=payoffCalculation?{
        option:payoffCalculation.chosenOption,
        optionLabel:payoffCalculation.optionLabel,
        elapsedDays:payoffCalculation.elapsedDays,
        chargedDays:payoffCalculation.chargedDays,
        cycleDays:payoffCalculation.cycleDays,
        explanation:payoffCalculation.explanation,
      }:undefined;

      await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)',[request.user!.id,'payment.post','payment',paymentId,request.id,JSON.stringify({loanId:loan.id,movementId,mode:parsed.data.mode,amount:plan.amount,allocations:plan.allocations,payoffDetails})]);
      await connection.commit();
      return reply.code(201).send({
        id:paymentId,
        loanId:String(loan.id),
        clientName:`${loan.firstName} ${loan.lastName}`,
        clientPhone:String(loan.phone??''),
        clientDocument:`${loan.documentType}: ${loan.documentNumber}`,
        product:String(loan.product),
        amount:plan.amount,
        currency:loan.currency,
        kind,
        paymentMethod:parsed.data.paymentMethod,
        reference:parsed.data.reference||null,
        paidAt:new Date().toISOString(),
        receivedBy:request.user!.name,
        status:'posted',
        remainingBalance:centsToAmount(remainingTotals),
        allocations:plan.allocations,
        breakdown:{capital:centsToAmount(capital),currentInterest:centsToAmount(currentInterest),lateInterest:centsToAmount(lateInterest),penalty:centsToAmount(penalty)},
        payoffDetails
      });
    }catch(error){await connection.rollback();if((error as {code?:string}).code==='ER_DUP_ENTRY'){const [rows]=await pool.execute('SELECT id,amount,loan_id AS loanId,status FROM payments WHERE idempotency_key=? LIMIT 1',[idempotencyKey.data]);const prior=(rows as Array<Record<string,string>>)[0];if(prior)return {id:prior.id,loanId:prior.loanId,amount:prior.amount,status:prior.status,idempotent:true};}throw error;}
    finally{connection.release();}
  });

  app.post('/api/loans/:id/pause', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const body=adjustmentSchema.safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:'Indica un motivo para pausar el préstamo.'});
    await runAccrualCycleForLoan(String(params.data.id));
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [settingsRows]=await connection.query('SELECT timezone FROM company_settings WHERE id=1 FOR UPDATE');const today=businessDate((settingsRows as Array<{timezone:string}>)[0]?.timezone??'America/Santo_Domingo');const [loanRows]=await connection.execute('SELECT id,product,status FROM loans WHERE id=? FOR UPDATE',[params.data.id]);const loan=(loanRows as Array<{id:string;product:string;status:string}>)[0];if(!loan){await connection.rollback();return reply.code(404).send({error:'No se encontró el préstamo.'});}if(loan.status!=='active'||loan.product!=='traditional'){await connection.rollback();return reply.code(409).send({error:'Solo se pueden pausar préstamos tradicionales activos.'});}const [dueRows]=await connection.execute("SELECT COUNT(*) AS total FROM installments WHERE loan_id=? AND status NOT IN ('paid','waived','overdue')",[loan.id]);if(Number((dueRows as Array<{total:number}>)[0].total)>0){await connection.rollback();return reply.code(409).send({error:'Para pausar, todas las cuotas pendientes deben estar vencidas.'});}const [allRows]=await connection.execute("SELECT COUNT(*) AS total FROM installments WHERE loan_id=? AND status NOT IN ('paid','waived')",[loan.id]);if(!Number((allRows as Array<{total:number}>)[0].total)){await connection.rollback();return reply.code(409).send({error:'El préstamo no tiene cuotas pendientes.'});}await connection.execute("UPDATE loans SET status='paused',paused_at=? WHERE id=?",[today,loan.id]);await connection.execute("INSERT INTO loan_adjustments (loan_id,action,reason,before_data,after_data,created_by,approved_by) VALUES (?,'pause',?,JSON_OBJECT('status','active'),JSON_OBJECT('status','paused','pausedAt',?),?,?)",[loan.id,body.data.reason,today,request.user!.id,request.user!.id]);await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,'loan.pause','loan',?,?,?)",[request.user!.id,loan.id,request.id,JSON.stringify({reason:body.data.reason,pausedAt:today})]);await connection.commit();return {id:String(loan.id),status:'paused',pausedAt:today};}catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.post('/api/loans/:id/resume', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const body=adjustmentSchema.safeParse(request.body);if(!params.success||!body.success)return reply.code(400).send({error:'Indica un motivo para reanudar el préstamo.'});const connection=await pool.getConnection();try{await connection.beginTransaction();const [settingsRows]=await connection.query('SELECT timezone FROM company_settings WHERE id=1 FOR UPDATE');const today=businessDate((settingsRows as Array<{timezone:string}>)[0]?.timezone??'America/Santo_Domingo');const [rows]=await connection.execute('SELECT id,status,paused_at,paused_days FROM loans WHERE id=? FOR UPDATE',[params.data.id]);const loan=(rows as Array<{id:string;status:string;paused_at:string|null;paused_days:number}>)[0];if(!loan){await connection.rollback();return reply.code(404).send({error:'No se encontró el préstamo.'});}if(loan.status!=='paused'||!loan.paused_at){await connection.rollback();return reply.code(409).send({error:'El préstamo no está pausado.'});}const pausedDays=Number(loan.paused_days)+dayDifference(dateOnly(loan.paused_at),today);await connection.execute("UPDATE loans SET status='active',paused_at=NULL,paused_days=? WHERE id=?",[pausedDays,loan.id]);await connection.execute("INSERT INTO loan_adjustments (loan_id,action,reason,before_data,after_data,created_by,approved_by) VALUES (?,'resume',?,JSON_OBJECT('status','paused','pausedDays',?),JSON_OBJECT('status','active','pausedDays',?,'resumedAt',?),?,?)",[loan.id,body.data.reason,loan.paused_days,pausedDays,today,request.user!.id,request.user!.id]);await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,'loan.resume','loan',?,?,?)",[request.user!.id,loan.id,request.id,JSON.stringify({reason:body.data.reason,pausedDays,resumedAt:today})]);await connection.commit();return {id:String(loan.id),status:'active',pausedDays};}catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.post('/api/loans/:id/installments/:installmentId/waive', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive(),installmentId:z.coerce.number().int().positive()}).safeParse(request.params);const body=adjustmentSchema.safeParse(request.body);if(!params.success||!body.success)return reply.code(400).send({error:'Indica un motivo para la condonación.'});const connection=await pool.getConnection();try{await connection.beginTransaction();const [rows]=await connection.execute('SELECT i.id,i.loan_id,i.late_interest_accrued,i.penalty_accrued FROM installments i JOIN loans l ON l.id=i.loan_id WHERE i.id=? AND i.loan_id=? FOR UPDATE',[params.data.installmentId,params.data.id]);const installment=(rows as Array<Record<string,string>>)[0];if(!installment){await connection.rollback();return reply.code(404).send({error:'No se encontró la cuota.'});}const [paidRows]=await connection.execute("SELECT component,SUM(amount) AS paid FROM payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.status='posted' WHERE a.installment_id=? AND a.component IN ('late_interest','penalty') GROUP BY component",[installment.id]);let latePaid=0n,penaltyPaid=0n;for(const row of paidRows as Array<{component:string;paid:string}>){if(row.component==='late_interest')latePaid=toCents(row.paid);if(row.component==='penalty')penaltyPaid=toCents(row.paid);}const before={late:installment.late_interest_accrued,penalty:installment.penalty_accrued};await connection.execute('UPDATE installments SET late_interest_accrued=?,penalty_accrued=? WHERE id=?',[centsToAmount(latePaid),centsToAmount(penaltyPaid),installment.id]);await connection.execute("INSERT INTO loan_adjustments (loan_id,installment_id,action,reason,before_data,after_data,created_by,approved_by) VALUES (?,?,'waive',?,?,?,?,?)",[installment.loan_id,installment.id,body.data.reason,JSON.stringify(before),JSON.stringify({late:centsToAmount(latePaid),penalty:centsToAmount(penaltyPaid)}),request.user!.id,request.user!.id]);await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,before_data,after_data) VALUES (?,'loan.waive','installment',?,?,?,?)",[request.user!.id,installment.id,request.id,JSON.stringify(before),JSON.stringify({reason:body.data.reason,late:centsToAmount(latePaid),penalty:centsToAmount(penaltyPaid)})]);await connection.commit();return {installmentId:String(installment.id),waivedLateInterest:centsToAmount(toCents(before.late)-latePaid),waivedPenalty:centsToAmount(toCents(before.penalty)-penaltyPaid)};}catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.put('/api/settings', { preHandler: [authenticate, async (request, reply) => authorize(['admin'], request, reply)] }, async (request, reply) => {
    const parsed = companySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.some(issue=>issue.path[0]==='timezone') ? 'La zona horaria no es válida. Usa un nombre IANA, por ejemplo Europe/Madrid.' : 'Revisa la configuración de empresa.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [beforeRows] = await connection.query('SELECT company_name AS companyName,currency,locale,timezone,grace_days_default AS graceDaysDefault FROM company_settings WHERE id=1 FOR UPDATE');
      const before = (beforeRows as Array<{currency:string}>)[0];
      if (before.currency !== parsed.data.currency) {
        const [[loanRows], [movementRows]] = await Promise.all([
          connection.query('SELECT COUNT(*) AS total FROM loans'),
          connection.query('SELECT COUNT(*) AS total FROM cash_movements'),
        ]);
        if (Number((loanRows as Array<{total:number}>)[0].total) || Number((movementRows as Array<{total:number}>)[0].total)) {
          await connection.rollback();
          return reply.code(409).send({ error: 'La moneda no se puede cambiar después del primer movimiento financiero. Contacta a un administrador para hacer una conversión controlada.' });
        }
      }
      await connection.execute('UPDATE company_settings SET company_name=?,currency=?,locale=?,timezone=?,grace_days_default=? WHERE id=1', [parsed.data.companyName,parsed.data.currency,parsed.data.locale,parsed.data.timezone,parsed.data.graceDaysDefault]);
      await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,before_data,after_data) VALUES (?,?,?,?,?,?,?)', [request.user!.id,'company.settings_update','company_settings',1,request.id,JSON.stringify(before),JSON.stringify(parsed.data)]);
      await connection.commit();
      return parsed.data;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });

  app.get('/api/reports/portfolio', { preHandler: authenticate }, async (request,reply) => {
    const parsed=z.object({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).safeParse(request.query);
    if(!parsed.success||!isCalendarDate(parsed.data.from)||!isCalendarDate(parsed.data.to)||parsed.data.from>parsed.data.to)return reply.code(400).send({error:'Selecciona un rango de fechas válido.'});
    if(dayDifference(parsed.data.from,parsed.data.to)>366)return reply.code(400).send({error:'El rango de informe no puede superar un año.'});
    const [settingRows]=await pool.query('SELECT currency FROM company_settings WHERE id=1');
    const currency=(settingRows as Array<{currency:string}>)[0]?.currency??'DOP';
    const [[portfolioRows],[incomeRows],[expenseRows],[categoryRows],[dailyIncomeRows],[dailyExpenseRows]]=await Promise.all([
      pool.query("SELECT product,status,COUNT(*) AS loanCount,COALESCE(SUM(principal),0) AS principalOriginated,COALESCE(SUM(principal_outstanding),0) AS principalOutstanding FROM loans GROUP BY product,status ORDER BY product,status"),
      pool.execute("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN capital_component ELSE -capital_component END),0) AS capitalReturned,COALESCE(SUM(CASE WHEN direction='in' THEN current_interest_component ELSE -current_interest_component END),0) AS currentInterest,COALESCE(SUM(CASE WHEN direction='in' THEN late_interest_component ELSE -late_interest_component END),0) AS lateInterest,COALESCE(SUM(CASE WHEN direction='in' THEN penalty_component ELSE -penalty_component END),0) AS penalty FROM cash_movements WHERE (movement_type IN ('payment_received','payment_reversal','loan_cancellation') OR (movement_type='adjustment' AND reference_type='loan')) AND occurred_at>=? AND occurred_at<DATE_ADD(?,INTERVAL 1 DAY)",[parsed.data.from,parsed.data.to]),
      pool.execute('SELECT COALESCE(SUM(amount),0) AS total,COUNT(*) AS expenseCount FROM expenses WHERE spent_at>=? AND spent_at<DATE_ADD(?,INTERVAL 1 DAY)',[parsed.data.from,parsed.data.to]),
      pool.execute('SELECT category,COALESCE(SUM(amount),0) AS total,COUNT(*) AS expenseCount FROM expenses WHERE spent_at>=? AND spent_at<DATE_ADD(?,INTERVAL 1 DAY) GROUP BY category ORDER BY total DESC,category',[parsed.data.from,parsed.data.to]),
      pool.execute("SELECT DATE_FORMAT(occurred_at,'%Y-%m-%d') AS reportDate,COALESCE(SUM(CASE WHEN direction='in' THEN current_interest_component+late_interest_component+penalty_component ELSE -(current_interest_component+late_interest_component+penalty_component) END),0) AS collectedIncome FROM cash_movements WHERE movement_type IN ('payment_received','payment_reversal') AND occurred_at>=? AND occurred_at<DATE_ADD(?,INTERVAL 1 DAY) GROUP BY DATE(occurred_at) ORDER BY DATE(occurred_at)",[parsed.data.from,parsed.data.to]),
      pool.execute("SELECT DATE_FORMAT(spent_at,'%Y-%m-%d') AS reportDate,COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE spent_at>=? AND spent_at<DATE_ADD(?,INTERVAL 1 DAY) GROUP BY DATE(spent_at) ORDER BY DATE(spent_at)",[parsed.data.from,parsed.data.to]),
    ]);
    const income=(incomeRows as Array<Record<string,string>>)[0]??{};
    const expense=(expenseRows as Array<Record<string,string>>)[0]??{};
    const collectedCurrent=Number(income.currentInterest??0);const collectedLate=Number(income.lateInterest??0);const collectedPenalty=Number(income.penalty??0);const expenseTotal=Number(expense.total??0);
    const dailyMap=new Map<string,{date:string;collectedIncome:number;expenses:number}>();
    for(const row of dailyIncomeRows as Array<{reportDate:string;collectedIncome:string}>){dailyMap.set(row.reportDate,{date:row.reportDate,collectedIncome:Number(row.collectedIncome),expenses:0});}
    for(const row of dailyExpenseRows as Array<{reportDate:string;expenses:string}>){const day=dailyMap.get(row.reportDate)??{date:row.reportDate,collectedIncome:0,expenses:0};day.expenses=Number(row.expenses);dailyMap.set(row.reportDate,day);}
    return {currency,period:{from:parsed.data.from,to:parsed.data.to},portfolio:(portfolioRows as Array<Record<string,string>>).map(row=>({product:row.product,status:row.status,loanCount:Number(row.loanCount),principalOriginated:Number(row.principalOriginated),principalOutstanding:Number(row.principalOutstanding)})),collected:{capitalReturned:Number(income.capitalReturned??0),currentInterest:collectedCurrent,lateInterest:collectedLate,penalty:collectedPenalty,totalIncome:collectedCurrent+collectedLate+collectedPenalty},expenses:{total:expenseTotal,count:Number(expense.expenseCount??0),byCategory:(categoryRows as Array<{category:string;total:string;expenseCount:string}>).map(row=>({category:row.category,total:Number(row.total),count:Number(row.expenseCount)}))},netProfitCollected:collectedCurrent+collectedLate+collectedPenalty-expenseTotal,daily:Array.from(dailyMap.values()).sort((a,b)=>a.date.localeCompare(b.date))};
  });

  app.get('/api/reports/loans.csv', { preHandler: authenticate }, async (_request,reply) => {
    const [rows]=await pool.query("SELECT l.id,c.first_name AS firstName,c.last_name AS lastName,c.document_type AS documentType,c.document_number AS documentNumber,l.product,l.status,l.principal,l.principal_outstanding AS principalOutstanding,l.interest_rate AS monthlyRate,l.grace_days AS graceDays,DATE_FORMAT(l.first_due_date,'%Y-%m-%d') AS firstDueDate,l.currency,l.created_at AS createdAt FROM loans l JOIN clients c ON c.id=l.client_id ORDER BY l.created_at DESC,l.id DESC");
    const cell=(value:unknown)=>{let text=String(value??'');if(/^\s*[=+@-]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;};
    const headers=['prestamo','nombre','apellidos','tipo_documento','documento','modalidad','estado','capital_original','capital_pendiente','tasa_mensual','dias_gracia','primer_vencimiento','moneda','creado'];
    const lines=[headers.map(cell).join(','),...(rows as Array<Record<string,unknown>>).map(row=>[row.id,row.firstName,row.lastName,row.documentType,row.documentNumber,row.product,row.status,row.principal,row.principalOutstanding,row.monthlyRate,row.graceDays,row.firstDueDate,row.currency,row.createdAt].map(cell).join(','))];
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="bankindon-cartera.csv"').header('Cache-Control','private, no-store').send(`\ufeff${lines.join('\r\n')}`);
  });

  app.get('/api/dashboard', { preHandler: authenticate }, async () => {
    const [[cashRows], [loanRows], [incomeRows], [expenseRows]] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS cashAvailable, COALESCE(SUM(CASE WHEN direction='in' AND movement_type='capital_injection' THEN amount ELSE 0 END),0) AS contributedCapital FROM cash_movements"),
      pool.query("SELECT COUNT(*) AS activeLoans, COALESCE(SUM(principal_outstanding),0) AS principalOutstanding, COALESCE(SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END),0) AS pausedLoans FROM loans WHERE status IN ('active','paused')"),
      pool.query("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN current_interest_component + late_interest_component + penalty_component ELSE -(current_interest_component + late_interest_component + penalty_component) END),0) AS collected FROM cash_movements WHERE movement_type IN ('payment_received','payment_reversal')"),
      pool.query('SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses'),
    ]);
    const [[accrualRows]] = await Promise.all([pool.query("SELECT COALESCE(SUM(GREATEST(interest_accrued - interest_paid, 0) + late_interest_accrued + penalty_accrued),0) AS pendingAccrued FROM installments WHERE status IN ('open','due','overdue')")]);
    const [[clientRows]] = await Promise.all([pool.query("SELECT COUNT(*) AS activeClients FROM clients WHERE status='active'")]);
    const cash = (cashRows as Array<Record<string,string>>)[0];
    const loans = (loanRows as Array<Record<string,string>>)[0];
    const income = (incomeRows as Array<Record<string,string>>)[0];
    const expense = (expenseRows as Array<Record<string,string>>)[0];
    const accrual = (accrualRows as Array<Record<string,string>>)[0];
    const clients = (clientRows as Array<Record<string,string>>)[0];
    const [settingsRows] = await pool.query('SELECT currency FROM company_settings WHERE id=1');
    const currency = (settingsRows as Array<{currency:string}>)[0]?.currency ?? 'DOP';
    return { currency, metrics: { cashAvailable: Number(cash.cashAvailable), contributedCapital: Number(cash.contributedCapital), activeLoans: Number(loans.activeLoans), principalOutstanding: Number(loans.principalOutstanding), collectedIncome: Number(income.collected), accruedPending: Number(accrual.pendingAccrued), expenses: Number(expense.expenses), netProfitCollected: Number(income.collected) - Number(expense.expenses), activeClients: Number(clients.activeClients), pausedLoans: Number(loans.pausedLoans) } };
  });

  app.get('/api/clients', { preHandler: authenticate }, async (request) => {
    const query = z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!query.success) return { items: [], total: 0 };
    const search = query.data.search?.trim();
    const pattern = `%${search ?? ''}%`;
    const [rows] = await pool.execute('SELECT id, first_name AS firstName, last_name AS lastName, document_type AS documentType, document_number AS documentNumber, phone, country_code AS countryCode, email, status, created_at AS createdAt FROM clients WHERE (? = \'%%\' OR CONCAT(first_name, \' \', last_name, \' \', document_number, \' \', phone) LIKE ?) ORDER BY created_at DESC LIMIT ? OFFSET ?', [pattern, pattern, query.data.limit, query.data.offset]);
    const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM clients WHERE (? = \'%%\' OR CONCAT(first_name, \' \', last_name, \' \', document_number, \' \', phone) LIKE ?)', [pattern, pattern]);
    return { items: rows, total: Number((countRows as Array<{total:string}>)[0].total) };
  });

  app.get('/api/clients/:id', { preHandler: authenticate }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);if(!params.success)return reply.code(400).send({error:'El cliente indicado no es válido.'});
    const connection=await pool.getConnection();try{
      const [rows]=await connection.execute("SELECT c.id,c.first_name AS firstName,c.last_name AS lastName,c.document_type AS documentType,c.document_number AS documentNumber,c.phone,c.country_code AS countryCode,c.email,c.address,DATE_FORMAT(c.birth_date,'%Y-%m-%d') AS birthDate,c.guarantor_client_id AS guarantorClientId,c.status,c.created_at AS createdAt,g.first_name AS guarantorFirstName,g.last_name AS guarantorLastName,g.document_type AS guarantorDocumentType,g.document_number AS guarantorDocumentNumber,g.phone AS guarantorPhone FROM clients c LEFT JOIN clients g ON g.id=c.guarantor_client_id WHERE c.id=?",[params.data.id]);
      const client=(rows as Array<Record<string,unknown>>)[0];if(!client)return reply.code(404).send({error:'No se encontró el cliente.'});
      const [loans]=await connection.execute("SELECT l.id,l.product,l.principal,l.principal_outstanding,l.interest_rate AS monthlyRate,l.status,DATE_FORMAT(l.first_due_date,'%Y-%m-%d') AS firstDueDate,l.grace_days AS graceDays,l.currency,l.created_at AS createdAt,c.first_name AS firstName,c.last_name AS lastName,c.document_number AS documentNumber,(SELECT COUNT(*) FROM installments i WHERE i.loan_id=l.id) AS installmentCount,(SELECT COALESCE(SUM(i.interest_accrued-i.interest_paid+i.late_interest_accrued+i.penalty_accrued),0) FROM installments i WHERE i.loan_id=l.id AND i.status IN ('open','due','overdue')) AS incomePending FROM loans l JOIN clients c ON c.id=l.client_id WHERE l.client_id=? AND l.status IN ('active','paused','paid') ORDER BY FIELD(l.status,'active','paused','paid'),l.created_at DESC,l.id DESC",[params.data.id]);
      const [guarantees]=await connection.execute("SELECT id,loan_id AS loanId,guarantee_type AS guaranteeType,description,estimated_value AS estimatedValue,status,notes,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS createdAt FROM client_guarantees WHERE client_id=? ORDER BY created_at DESC,id DESC",[params.data.id]);
      const loanItems=loans as Array<Record<string,unknown>>;const guarantor=client.guarantorClientId?{id:String(client.guarantorClientId),firstName:client.guarantorFirstName,lastName:client.guarantorLastName,documentType:client.guarantorDocumentType,documentNumber:client.guarantorDocumentNumber,phone:client.guarantorPhone}:null;
      const [allLoanRows]=await connection.execute('SELECT COUNT(*) AS total FROM loans WHERE client_id=?',[params.data.id]);
      const allLoans=Number((allLoanRows as Array<{total:string}>)[0]?.total??0);
      return {client:{...client,id:String(client.id),guarantorClientId:client.guarantorClientId?String(client.guarantorClientId):null,guarantor},loans:loanItems.map(item=>({...item,id:String(item.id)})),guarantees,loanCounts:{active:loanItems.filter(item=>item.status==='active'||item.status==='paused').length,paid:loanItems.filter(item=>item.status==='paid').length,total:loanItems.length,all:allLoans}};
    }finally{connection.release();}
  });

  app.patch('/api/clients/:id', { preHandler: [authenticate, async (request, reply) => authorize(['admin', 'supervisor'], request, reply)] }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    const parsed = clientUpdateSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'Revisa los datos del cliente.' });
    if (parsed.data.birthDate && !isCalendarDate(parsed.data.birthDate)) return reply.code(400).send({ error: 'La fecha de nacimiento no es válida.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute("SELECT id,first_name AS firstName,last_name AS lastName,document_type AS documentType,document_number AS documentNumber,phone,country_code AS countryCode,email,address,DATE_FORMAT(birth_date,'%Y-%m-%d') AS birthDate,status FROM clients WHERE id=? FOR UPDATE", [params.data.id]);
      const before = (rows as Array<Record<string, unknown>>)[0];
      if (!before) { await connection.rollback(); return reply.code(404).send({ error: 'No se encontró el cliente.' }); }
      const [duplicateRows] = await connection.execute('SELECT id FROM clients WHERE document_type=? AND document_number=? AND id<>? LIMIT 1 FOR UPDATE', [parsed.data.documentType, parsed.data.documentNumber, params.data.id]);
      if ((duplicateRows as unknown[]).length) { await connection.rollback(); return reply.code(409).send({ error: 'Ya existe otro cliente con ese documento.' }); }
      const birthDate = parsed.data.birthDate || null;
      await connection.execute('UPDATE clients SET first_name=?,last_name=?,document_type=?,document_number=?,phone=?,country_code=?,email=?,address=?,birth_date=?,status=? WHERE id=?', [parsed.data.firstName, parsed.data.lastName, parsed.data.documentType, parsed.data.documentNumber, parsed.data.phone, parsed.data.countryCode, parsed.data.email || null, parsed.data.address || null, birthDate, parsed.data.status, params.data.id]);
      await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,before_data,after_data) VALUES (?,'client.update','client',?,?,?,?)", [request.user!.id, params.data.id, request.id, JSON.stringify(before), JSON.stringify({ ...parsed.data, email: parsed.data.email || null, address: parsed.data.address || null, birthDate })]);
      await connection.commit();
      return { ok: true, id: String(params.data.id) };
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'Ya existe otro cliente con ese documento.' });
      throw error;
    } finally { connection.release(); }
  });

  app.delete('/api/clients/:id', { preHandler: [authenticate, async (request, reply) => authorize(['admin', 'supervisor'], request, reply)] }, async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'El cliente indicado no es válido.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT id,first_name AS firstName,last_name AS lastName,document_type AS documentType,document_number AS documentNumber,phone,email,address,status,created_at AS createdAt FROM clients WHERE id=? FOR UPDATE', [params.data.id]);
      const client = (rows as Array<Record<string, unknown>>)[0];
      if (!client) { await connection.rollback(); return reply.code(404).send({ error: 'No se encontró el cliente.' }); }
      const [loanRows] = await connection.execute('SELECT COUNT(*) AS total FROM loans WHERE client_id=?', [params.data.id]);
      const loanCount = Number((loanRows as Array<{ total: string }>)[0]?.total ?? 0);
      if (loanCount > 0) {
        await connection.rollback();
        return reply.code(409).send({ error: `No se puede eliminar el cliente porque tiene ${loanCount} préstamo${loanCount === 1 ? '' : 's'} registrado${loanCount === 1 ? '' : 's'}.` });
      }
      const [paymentRows] = await connection.execute('SELECT COUNT(*) AS total FROM payments WHERE client_id=?', [params.data.id]);
      if (Number((paymentRows as Array<{ total: string }>)[0]?.total ?? 0) > 0) {
        await connection.rollback();
        return reply.code(409).send({ error: 'No se puede eliminar el cliente porque tiene pagos registrados.' });
      }
      await connection.execute('DELETE FROM client_documents WHERE client_id=?', [params.data.id]);
      await connection.execute('DELETE FROM client_guarantees WHERE client_id=?', [params.data.id]);
      await connection.execute('DELETE FROM clients WHERE id=?', [params.data.id]);
      await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,before_data) VALUES (?,'client.delete','client',?,?,?)", [request.user!.id, params.data.id, request.id, JSON.stringify(client)]);
      await connection.commit();
      return { ok: true };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  });

  app.patch('/api/clients/:id/profile', { preHandler:[authenticate,async(request,reply)=>authorize(['admin','supervisor'],request,reply)] }, async(request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const parsed=clientProfileSchema.safeParse(request.body);if(!params.success||!parsed.success)return reply.code(400).send({error:'Revisa los datos de la ficha.'});
    const birthDate=parsed.data.birthDate||null;const guarantorId=parsed.data.guarantorClientId??null;if(guarantorId&&Number(guarantorId)===params.data.id)return reply.code(400).send({error:'El cliente no puede ser su propio garante.'});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [exists]=await connection.execute('SELECT id FROM clients WHERE id=? FOR UPDATE',[params.data.id]);if(!(exists as unknown[]).length){await connection.rollback();return reply.code(404).send({error:'No se encontró el cliente.'});}if(guarantorId){const [guarantor]=await connection.execute("SELECT id FROM clients WHERE id=? AND status='active' FOR UPDATE",[guarantorId]);if(!(guarantor as unknown[]).length){await connection.rollback();return reply.code(400).send({error:'Selecciona una persona activa como garante.'});}}
      await connection.execute('UPDATE clients SET birth_date=?,guarantor_client_id=? WHERE id=?',[birthDate,guarantorId,params.data.id]);await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,'client.profile_update','client',?,?,?)",[request.user!.id,params.data.id,request.id,JSON.stringify({birthDate,guarantorClientId:guarantorId})]);await connection.commit();return {ok:true};
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.post('/api/clients/:id/guarantees', { preHandler:[authenticate,async(request,reply)=>authorize(['admin','supervisor'],request,reply)] }, async(request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);const parsed=clientGuaranteeSchema.safeParse(request.body);if(!params.success||!parsed.success)return reply.code(400).send({error:'Completa el tipo y la descripción de la garantía.'});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [clientRows]=await connection.execute("SELECT id FROM clients WHERE id=? AND status='active' FOR UPDATE",[params.data.id]);if(!(clientRows as unknown[]).length){await connection.rollback();return reply.code(404).send({error:'El cliente no existe o está inactivo.'});}if(parsed.data.loanId){const [loanRows]=await connection.execute("SELECT id FROM loans WHERE id=? AND client_id=? FOR UPDATE",[parsed.data.loanId,params.data.id]);if(!(loanRows as unknown[]).length){await connection.rollback();return reply.code(400).send({error:'El préstamo seleccionado no pertenece a este cliente.'});}}
      const [result]=await connection.execute("INSERT INTO client_guarantees (client_id,loan_id,guarantee_type,description,estimated_value,notes,created_by) VALUES (?,?,?,?,?,?,?)",[params.data.id,parsed.data.loanId??null,parsed.data.guaranteeType,parsed.data.description,parsed.data.estimatedValue||null,parsed.data.notes||null,request.user!.id]);const id=String((result as ResultSetHeader).insertId);await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,'client.guarantee_create','client_guarantee',?,?,?)",[request.user!.id,id,request.id,JSON.stringify({...parsed.data,clientId:params.data.id})]);await connection.commit();return reply.code(201).send({id});
    }catch(error){await connection.rollback();throw error;}finally{connection.release();}
  });

  app.post('/api/clients/import/preview', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const parsed=clientImportSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'Sube un archivo CSV válido de hasta 500 clientes.'});
    try{const result=await analyzeClientCsv(parsed.data.csv);return {...result,items:result.items.slice(0,200)};}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'No se pudo revisar el CSV.'});}
  });

  app.post('/api/clients/import', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const parsed=clientImportSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:'Sube un archivo CSV válido de hasta 500 clientes.'});
    const connection=await pool.getConnection();try{await connection.beginTransaction();await connection.query('SELECT id FROM company_settings WHERE id=1 FOR UPDATE');const report=await analyzeClientCsv(parsed.data.csv,connection);const ready=report.items.filter((item)=>item.status==='ready'&&item.client);if(!ready.length){await connection.rollback();return reply.code(409).send({error:'No hay clientes nuevos válidos para importar.',report:{total:report.total,valid:report.valid,duplicates:report.duplicates,invalid:report.invalid,items:report.items.slice(0,200)}});}for(const item of ready){const client=item.client!;await connection.execute('INSERT INTO clients (first_name,last_name,document_type,document_number,phone,country_code,email,address,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',[client.firstName,client.lastName,client.documentType,client.documentNumber,client.phone,client.countryCode,client.email,client.address,client.status,request.user!.id]);}await connection.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,'client.import','client',NULL,?,?)",[request.user!.id,request.id,JSON.stringify({imported:ready.length,duplicates:report.duplicates,invalid:report.invalid,total:report.total})]);await connection.commit();return reply.code(201).send({imported:ready.length,duplicates:report.duplicates,invalid:report.invalid,total:report.total,items:report.items.slice(0,200)});}catch(error){await connection.rollback();if((error as {code?:string}).code==='ER_DUP_ENTRY')return reply.code(409).send({error:'Otro proceso importó un documento del archivo. Vuelve a generar la vista previa.'});throw error;}finally{connection.release();}
  });

  app.get('/api/clients/:id/documents', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const params=z.object({id:z.coerce.number().int().positive()}).safeParse(request.params);if(!params.success)return reply.code(400).send({error:'Cliente no válido.'});
    const [rows]=await pool.execute('SELECT id,side,mime_type AS mimeType,original_name AS originalName,file_size AS fileSize,created_at AS createdAt FROM client_documents WHERE client_id=? ORDER BY side',[params.data.id]);return rows;
  });

  app.get('/api/client-documents/:documentId/file', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request,reply)=>{
    const params=z.object({documentId:z.coerce.number().int().positive()}).safeParse(request.params);if(!params.success)return reply.code(400).send({error:'Documento no válido.'});
    const [rows]=await pool.execute('SELECT id,client_id AS clientId,mime_type AS mimeType,original_name AS originalName,encrypted_content AS encryptedContent FROM client_documents WHERE id=?',[params.data.documentId]);const document=(rows as Array<{id:string;clientId:string;mimeType:string;originalName:string;encryptedContent:Buffer}>)[0];if(!document)return reply.code(404).send({error:'No se encontró el documento.'});
    const content=decryptDocument(Buffer.from(document.encryptedContent));const safeName=document.originalName.replace(/[\r\n"\\/]/g,'_');await pool.execute("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,'client.document_view','client_document',?,?,JSON_OBJECT('clientId',?))",[request.user!.id,document.id,request.id,document.clientId]);
    reply.header('Cache-Control','private, no-store, max-age=0').header('Pragma','no-cache').header('X-Content-Type-Options','nosniff').header('Content-Disposition',`inline; filename="${safeName}"`).type(document.mimeType);return reply.send(content);
  });

  app.post('/api/clients', { bodyLimit:15*1024*1024, preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor','collector'], request, reply)] }, async (request, reply) => {
    const parsed = clientCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Completa correctamente los datos del cliente.', details: parsed.error.flatten().fieldErrors });
    let decoded:Array<(typeof parsed.data.documents extends Array<infer T>|undefined?T:never)&{mimeType:'image/jpeg'|'image/png'|'image/webp';content:Buffer}>;
    try{decoded=(parsed.data.documents??[]).map((document)=>({...document,...decodeClientImage(document.dataUrl)}));}catch(error){return reply.code(400).send({error:error instanceof Error?error.message:'La imagen del documento no es válida.'});}
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [result]=await connection.execute('INSERT INTO clients (first_name,last_name,document_type,document_number,phone,country_code,email,address,created_by) VALUES (?,?,?,?,?,?,?,?,?)',[parsed.data.firstName,parsed.data.lastName,parsed.data.documentType,parsed.data.documentNumber,parsed.data.phone,parsed.data.countryCode,parsed.data.email||null,parsed.data.address||null,request.user!.id]);const id=String((result as ResultSetHeader).insertId);
      for(const document of decoded){const originalName=document.fileName.replace(/[\r\n"\\/\0]/g,'_').slice(-160)||(document.side+'.'+document.mimeType.split('/')[1]);await connection.execute('INSERT INTO client_documents (client_id,side,mime_type,original_name,file_size,sha256,encrypted_content,uploaded_by) VALUES (?,?,?,?,?,?,?,?)',[id,document.side,document.mimeType,originalName,document.content.length,documentSha256(document.content),encryptDocument(document.content),request.user!.id]);}
      const {documents,...clientData}=parsed.data;await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)',[request.user!.id,'client.create','client',id,request.id,JSON.stringify({...clientData,documentSides:documents?.map((document)=>document.side)??[]})]);await connection.commit();return reply.code(201).send({id,...clientData,hasDocuments:decoded.length>0,status:'active'});
    } catch (error) {await connection.rollback();
      if ((error as {code?:string}).code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'Ya existe un cliente con ese documento.' });
      throw error;
    }finally{connection.release();}
  });

  app.post('/api/cash/capital', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request, reply) => {
    const parsed = amountSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Indica un importe y concepto válidos.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [settings] = await connection.query('SELECT currency FROM company_settings WHERE id=1 FOR UPDATE');
      const currency = (settings as Array<{currency:string}>)[0]?.currency ?? 'DOP';
      const [result] = await connection.execute("INSERT INTO cash_movements (movement_type,direction,amount,description,occurred_at,recorded_by) VALUES ('capital_injection','in',?,?,NOW(),?)", [parsed.data.amount.toFixed(2), parsed.data.description, request.user!.id]);
      const id = String((result as ResultSetHeader).insertId);
      await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)', [request.user!.id,'cash.capital_injection','cash_movement',id,request.id,JSON.stringify({ ...parsed.data, currency })]);
      await connection.commit();
      return reply.code(201).send({ id, amount: parsed.data.amount, currency });
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });

  app.post('/api/expenses', { preHandler: [authenticate, async (request, reply) => authorize(['admin','supervisor'], request, reply)] }, async (request, reply) => {
    const parsed = expenseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Completa correctamente los datos del gasto.' });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM company_settings WHERE id=1 FOR UPDATE');
      const [cashRows] = await connection.query("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS available FROM cash_movements");
      const available = Number((cashRows as Array<{available:string}>)[0].available);
      if (available < parsed.data.amount) {
        await connection.rollback();
        return reply.code(409).send({ error: 'El gasto supera el efectivo disponible en caja.' });
      }
      const date = parsed.data.spentAt ? new Date(parsed.data.spentAt) : new Date();
      const [movement] = await connection.execute("INSERT INTO cash_movements (movement_type,direction,amount,description,occurred_at,recorded_by) VALUES ('expense','out',?,?,?,?)", [parsed.data.amount.toFixed(2), `${parsed.data.category}: ${parsed.data.description}`, date, request.user!.id]);
      const movementId = String((movement as ResultSetHeader).insertId);
      const [result] = await connection.execute('INSERT INTO expenses (category,description,amount,spent_at,recorded_by,cash_movement_id) VALUES (?,?,?,?,?,?)', [parsed.data.category, parsed.data.description, parsed.data.amount.toFixed(2), date, request.user!.id, movementId]);
      const id = String((result as ResultSetHeader).insertId);
      await connection.execute('INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_data) VALUES (?,?,?,?,?,?)', [request.user!.id,'expense.create','expense',id,request.id,JSON.stringify(parsed.data)]);
      await connection.commit();
      return reply.code(201).send({ id, amount: parsed.data.amount });
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });

  app.get('/api/cash/movements', { preHandler: authenticate }, async (request) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).safeParse(request.query);
    const [rows] = await pool.execute('SELECT id,movement_type AS type,direction,amount,capital_component AS capitalComponent,current_interest_component AS currentInterest,late_interest_component AS lateInterest,penalty_component AS penalty,description,occurred_at AS occurredAt FROM cash_movements ORDER BY occurred_at DESC,id DESC LIMIT ?', [q.success ? q.data.limit : 20]);
    return rows;
  });
}
