import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.js';
import { requireAdmin } from './admin.js';
import { requirePortalUser } from '../portal-auth.js';
import { rateLimit } from '../rate-limit.js';

const verified="verified_at IS NOT NULL AND paid_at IS NOT NULL AND status IN ('paid','partially_refunded','refunded')";
const profileColumns='business_type,business_name,phone,website,address,city,state,postal_code,country,tax_id,updated_at';
const paymentColumns='id,provider,provider_payment_id,order_reference,amount_minor,refunded_minor,currency,status,plan_code,billing_term,paid_at,verified_at,period_start,period_end,created_at';

export async function registerCustomerRoutes(app:FastifyInstance,secret:string) {
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
  app.get<{Querystring:{q?:string;page?:string;paid?:string}}>('/v1/admin/customers',async(req,reply)=>{
    if(!requireAdmin(req,reply))return;
    const db=getPool();if(!db)return reply.code(503).send({error:'Database unavailable'});
    const q=req.query.q?.trim() || '',page=Number(req.query.page || 1),paid=req.query.paid || 'all';
    if(q.length>200 || !Number.isInteger(page) || page<1 || page>100000 || !['all','paid','unpaid'].includes(paid))return reply.code(400).send({error:'Invalid search, page or payment filter'});
    const filter=`($1='' OR POSITION(LOWER($1) IN LOWER(CONCAT_WS(' ',c.name,c.email,c.company,c.app_id,b.business_name)))>0)
      AND ($2='all' OR ($2='paid' AND COALESCE(p.payment_count,0)>0) OR ($2='unpaid' AND COALESCE(p.payment_count,0)=0))`;
    const base=`FROM customer_accounts c JOIN apps a ON a.app_id=c.app_id LEFT JOIN customer_business_profiles b ON b.account_id=c.id
      LEFT JOIN (SELECT account_id,COUNT(*)::int payment_count,SUM(amount_minor)::text total_paid_minor,SUM(refunded_minor)::text refunded_minor,MAX(paid_at) last_paid_at
        FROM customer_payments WHERE ${verified} GROUP BY account_id) p ON p.account_id=c.id WHERE ${filter}`;
    const [summary,customers,count]=await Promise.all([
      db.query(`SELECT (SELECT COUNT(*)::int FROM customer_accounts) registered_customers,COUNT(DISTINCT account_id)::int paying_customers,COUNT(*)::int verified_payments,
        COALESCE(SUM(amount_minor),0)::text gross_minor,COALESCE(SUM(refunded_minor),0)::text refunds_minor,COALESCE(SUM(amount_minor-refunded_minor),0)::text net_minor FROM customer_payments WHERE ${verified}`),
      db.query(`SELECT c.id,c.name,c.email,c.company,c.app_id,c.created_at,a.plan,a.active,b.business_name,COALESCE(p.payment_count,0) payment_count,
        COALESCE(p.total_paid_minor,'0') total_paid_minor,COALESCE(p.refunded_minor,'0') refunded_minor,p.last_paid_at ${base} ORDER BY c.created_at DESC,c.id LIMIT 25 OFFSET $3`,[q,paid,(page-1)*25]),
      db.query(`SELECT COUNT(*)::int total ${base}`,[q,paid]),
    ]);
    return {summary:summary.rows[0],currency:'INR',scope:'all_time',customers:customers.rows,total:count.rows[0].total,page,pageSize:25,paymentIntegration:'not_connected'};
  });
  app.get<{Params:{accountId:string};Querystring:{page?:string}}>('/v1/admin/customers/:accountId',async(req,reply)=>{
    if(!requireAdmin(req,reply))return;
    const {accountId}=req.params,page=Number(req.query.page || 1);
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(accountId) || !Number.isInteger(page) || page<1 || page>100000)return reply.code(400).send({error:'Invalid customer or page'});
    const db=getPool();if(!db)return reply.code(503).send({error:'Database unavailable'});
    const account=await db.query(`SELECT c.id,c.name,c.email,c.company,c.app_id,c.created_at,c.email_verified_at,a.name project_name,a.plan,a.active
      FROM customer_accounts c JOIN apps a ON a.app_id=c.app_id WHERE c.id=$1`,[accountId]);
    if(!account.rows.length)return reply.code(404).send({error:'Customer not found'});
    const [profile,payments,count]=await Promise.all([
      db.query(`SELECT ${profileColumns} FROM customer_business_profiles WHERE account_id=$1`,[accountId]),
      db.query(`SELECT ${paymentColumns} FROM customer_payments WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $2`,[accountId,(page-1)*25]),
      db.query('SELECT COUNT(*)::int total FROM customer_payments WHERE account_id=$1',[accountId]),
    ]);
    return {account:account.rows[0],profile:profile.rows[0] || null,payments:payments.rows,total:count.rows[0].total,page,pageSize:25};
  });
  app.get('/v1/portal/business-profile',async(req,reply)=>{
    const claims=await requirePortalUser(req,reply,secret);if(!claims)return;
    const db=getPool();if(!db)return reply.code(503).send({error:'Database unavailable'});
    const account=await db.query('SELECT id,company FROM customer_accounts WHERE app_id=$1',[claims.appId]);
    if(!account.rows.length)return reply.code(404).send({error:'Customer account not found'});
    const result=await db.query(`SELECT ${profileColumns} FROM customer_business_profiles WHERE account_id=$1`,[account.rows[0].id]);
    return {profile:result.rows[0] || {business_type:'individual',business_name:account.rows[0].company || ''}};
  });
  app.put<{Body:Record<string,unknown>}>('/v1/portal/business-profile',{bodyLimit:8192},async(req,reply)=>{
    const claims=await requirePortalUser(req,reply,secret);if(!claims)return;
    if(!rateLimit(`business-profile:${claims.appId}`,20,60000))return reply.code(429).send({error:'Too many updates'});
    const fields:Record<string,number>={business_type:20,business_name:255,phone:40,website:500,address:1000,city:100,state:100,postal_code:30,country:100,tax_id:40};
    const values:Record<string,string>={};
    for(const [field,max] of Object.entries(fields)){
      const value=req.body?.[field] ?? '';
      if(typeof value!=='string' || value.length>max)return reply.code(400).send({error:`Invalid ${field}`});
      values[field]=value.trim();
    }
    if(!['individual','business'].includes(values.business_type))return reply.code(400).send({error:'Choose individual or business'});
    if(values.website){try{if(!['http:','https:'].includes(new URL(values.website).protocol))throw new Error();}catch{return reply.code(400).send({error:'Website must be an http or https URL'});}}
    const db=getPool();if(!db)return reply.code(503).send({error:'Database unavailable'});
    const names=Object.keys(fields);
    const result=await db.query(`INSERT INTO customer_business_profiles (account_id,${names.join(',')})
      SELECT id,${names.map((_,i)=>`$${i+2}`).join(',')} FROM customer_accounts WHERE app_id=$1
      ON CONFLICT (account_id) DO UPDATE SET ${names.map(n=>`${n}=EXCLUDED.${n}`).join(',')},updated_at=NOW() RETURNING account_id`,[claims.appId,...names.map(n=>values[n])]);
    if(!result.rows.length)return reply.code(404).send({error:'Customer account not found'});
    return {ok:true};
  });
}
