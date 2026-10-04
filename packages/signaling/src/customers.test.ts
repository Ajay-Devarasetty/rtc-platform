import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { getPool,closeDb } from './db.js';
import { issueToken } from './auth.js';
import { registerCustomerRoutes } from './routes/customers.js';

test('admin customer reporting and customer-owned business profiles',async t=>{
  const previous={db:process.env.DATABASE_URL,admin:process.env.ADMIN_API_KEY};
  process.env.DATABASE_URL='postgresql://unused/customer-tests';process.env.ADMIN_API_KEY='test-admin';
  const pg=new PGlite(),app=Fastify();
  t.after(async()=>{await app.close();await closeDb();await pg.close();if(previous.db===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous.db;if(previous.admin===undefined)delete process.env.ADMIN_API_KEY;else process.env.ADMIN_API_KEY=previous.admin;});
  await pg.exec(`CREATE TABLE apps(app_id VARCHAR(64) PRIMARY KEY,name TEXT,plan TEXT,active BOOLEAN DEFAULT TRUE,portal_version INTEGER DEFAULT 0);
    INSERT INTO apps(app_id,name,plan) VALUES ('app-a','First project','pro'),('app-b','Second project','free');`);
  await pg.exec(await readFile(new URL('../migrations/012_customer_accounts.sql',import.meta.url),'utf8'));
  await pg.exec('ALTER TABLE customer_accounts ADD COLUMN email_verified_at TIMESTAMPTZ');
  const migration=await readFile(new URL('../migrations/017_customer_reporting.sql',import.meta.url),'utf8');await pg.exec(migration);await pg.exec(migration);
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  await pg.query(`INSERT INTO customer_accounts(id,email,password_hash,name,company,app_id) VALUES ($1,'first@example.test','SENSITIVE-HASH','First','Original business','app-a'),($2,'second@example.test','OTHER-HASH','Second',NULL,'app-b')`,[a,b]);
  t.mock.method(getPool()!,'query',async(sql:string,args?:unknown[])=>{const result=await pg.query(sql,args);return {...result,rowCount:result.rows.length || result.affectedRows};});
  await app.register(async scope=>registerCustomerRoutes(scope,'test'));
  const admin={'x-admin-key':'test-admin'};
  const portal=(appId='app-a')=>({authorization:`Bearer ${issueToken({appId,userId:'__portal__'},'test')}`});
  await t.test('customer and anonymous tokens cannot see the admin directory or payment records',async()=>{
    for(const url of ['/v1/admin/customers',`/v1/admin/customers/${a}`]){
      assert.equal((await app.inject({url})).statusCode,401);assert.equal((await app.inject({url,headers:portal()})).statusCode,401);
    }
    const res=await app.inject({url:'/v1/admin/customers',headers:admin});assert.equal(res.statusCode,200);assert.equal(res.headers['cache-control'],'no-store');
    assert.equal(res.json().summary.registered_customers,2);assert.equal(res.json().summary.paying_customers,0);assert.equal(res.json().paymentIntegration,'not_connected');assert.ok(!res.body.includes('HASH'));
  });
  await t.test('profiles can only update the signed-in customer and cannot create payments',async()=>{
    assert.equal((await app.inject({url:'/v1/portal/business-profile',headers:portal()})).json().profile.business_name,'Original business');
    const payload={business_type:'individual',business_name:'My studio <script>',phone:'+91 12345',website:'https://example.test',address:'Office address',country:'India',account_id:b,amount_minor:99999,verified_at:new Date().toISOString()};
    const saved=await app.inject({url:'/v1/portal/business-profile',method:'PUT',headers:portal(),payload});assert.equal(saved.statusCode,200,saved.body);
    assert.equal((await app.inject({url:'/v1/portal/business-profile',headers:portal('app-b')})).json().profile.business_name,'');
    assert.equal((await pg.query('SELECT * FROM customer_payments')).rows.length,0);
    const detail=await app.inject({url:`/v1/admin/customers/${a}`,headers:admin});assert.equal(detail.json().profile.phone,'+91 12345');assert.ok(!detail.body.includes('SENSITIVE-HASH'));
    assert.equal((await app.inject({url:'/v1/portal/business-profile',method:'PUT',headers:portal(),payload:{...payload,website:'javascript:alert(1)'}})).statusCode,400);
    await pg.exec("UPDATE apps SET portal_version=1 WHERE app_id='app-a'");assert.equal((await app.inject({url:'/v1/portal/business-profile',headers:portal()})).statusCode,401);await pg.exec("UPDATE apps SET portal_version=0 WHERE app_id='app-a'");
  });
  await t.test('totals count only verified paid transactions and subtract refunds',async()=>{
    // Test fixture insertion represents trusted provider verification, never a client request.
    await pg.query(`INSERT INTO customer_payments(account_id,provider,provider_payment_id,amount_minor,refunded_minor,status,plan_code,billing_term,paid_at,verified_at)
      VALUES ($1,'instamojo','paid-1',10000,0,'paid','pro','monthly',NOW(),NOW()),
      ($1,'instamojo','refund-1',20000,5000,'partially_refunded','pro','yearly',NOW(),NOW()),
      ($2,'instamojo','pending-1',90000,0,'pending','pro','yearly',NULL,NULL),
      ($2,'instamojo','unverified-1',80000,0,'paid','pro','yearly',NOW(),NULL)`,[a,b]);
    const res=await app.inject({url:'/v1/admin/customers',headers:admin});const s=res.json().summary;
    assert.equal(s.paying_customers,1);assert.equal(s.verified_payments,2);assert.equal(s.gross_minor,'30000');assert.equal(s.refunds_minor,'5000');assert.equal(s.net_minor,'25000');
    const paid=await app.inject({url:'/v1/admin/customers?paid=paid',headers:admin});assert.equal(paid.json().total,1);assert.equal(paid.json().customers[0].id,a);
    const unpaid=await app.inject({url:'/v1/admin/customers?paid=unpaid',headers:admin});assert.equal(unpaid.json().customers[0].id,b);
    const search=await app.inject({url:'/v1/admin/customers?q=studio',headers:admin});assert.equal(search.json().total,1);
    const detail=await app.inject({url:`/v1/admin/customers/${a}`,headers:admin});assert.equal(detail.json().payments.length,2);assert.equal(detail.json().payments[0].billing_term,'yearly');
    const foreign=await app.inject({url:`/v1/admin/customers/${b}`,headers:admin});assert.ok(foreign.json().payments.every((p:any)=>!p.provider_payment_id.startsWith('refund')));
    await assert.rejects(pg.query(`INSERT INTO customer_payments(account_id,provider,provider_payment_id,amount_minor,status,plan_code,billing_term) VALUES ($1,'instamojo','paid-1',100,'paid','pro','monthly')`,[a]));
  });
  await t.test('pagination and invalid requests do not expose records or SQL errors',async()=>{
    const page=await app.inject({url:'/v1/admin/customers?page=2',headers:admin});assert.equal(page.json().customers.length,0);assert.equal(page.json().total,2);
    assert.equal((await app.inject({url:'/v1/admin/customers?page=-1',headers:admin})).statusCode,400);
    assert.equal((await app.inject({url:'/v1/admin/customers/------------------------------------',headers:admin})).statusCode,400);
    assert.equal((await app.inject({url:'/v1/admin/customers?q=%27%20OR%201%3D1',headers:admin})).json().total,0);
    assert.equal((await app.inject({url:`/v1/admin/customers/${a}`,method:'POST',headers:admin,payload:{status:'paid'}})).statusCode,404);
  });
});
