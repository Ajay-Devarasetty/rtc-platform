import { randomUUID } from 'node:crypto';
import { getPool } from './db.js';
import { pushCredentials, sendFcm } from './push.js';
import { apnsCredentials } from './push-credentials.js';
import { sendApns, type PushResult } from './apns.js';

export async function removeChatSubscription(appId:string,roomId:string,userId?:string) {
  await getPool()?.query(`WITH removed AS (
    DELETE FROM chat_push_subscriptions WHERE app_id=$1 AND room_id=$2 AND ($3::text IS NULL OR user_id=$3) RETURNING user_id
  ) UPDATE message_push_jobs j SET state='skipped',lease=NULL FROM messages m,removed r
    WHERE j.app_id=$1 AND j.message_id=m.id AND m.app_id=$1 AND m.room_id=$2 AND j.user_id=r.user_id AND j.state='pending'`,[appId,roomId,userId ?? null]);
}
// Jobs contain no chat text or device tokens. They resolve current credentials and
// ownership before each attempt, so logout, rotation and unsubscribe take effect.
export async function processMessagePushJobs(isOnline:(appId:string,userId:string)=>Promise<boolean>) {
  const db=getPool();if(!db)return;
  const lease=randomUUID();
  const jobs=await db.query(`WITH picked AS (
    SELECT id FROM message_push_jobs WHERE state='pending' AND available_at<=NOW() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10
  ) UPDATE message_push_jobs j SET lease=$1,attempts=attempts+1,available_at=NOW()+INTERVAL '2 minutes'
    FROM picked WHERE j.id=picked.id RETURNING j.*`,[lease]);
  await Promise.all(jobs.rows.map(async job=>{
    const finish=async(state:string)=>db.query('UPDATE message_push_jobs SET state=$3,lease=NULL WHERE id=$1 AND lease=$2',[job.id,lease,state]);
    try {
      if(Date.now()-new Date(job.created_at).getTime()>86400000 || job.attempts>5){await finish('expired');return;}
      const target=await db.query(`SELECT d.*,m.room_id FROM messages m
        JOIN chat_push_subscriptions s ON s.app_id=m.app_id AND s.room_id=m.room_id AND s.user_id=$3
        JOIN push_devices d ON d.app_id=s.app_id AND d.user_id=s.user_id AND d.installation_id=$4 AND d.push_type='alert'
        WHERE m.app_id=$1 AND m.id=$2 AND m.from_user_id<>$3 AND d.updated_at>NOW()-INTERVAL '90 days'`,[job.app_id,job.message_id,job.user_id,job.installation_id]);
      const device=target.rows[0];
      if(!device || (device.app_state!=='background' && await isOnline(job.app_id,job.user_id))){await finish('skipped');return;}
      const data={type:'rtc_chat_message',messageId:String(job.message_id),roomId:device.room_id};
      const notification={title:'New message',body:'You have a new chat message.'};
      let result:PushResult;
      if(device.platform==='ios'){
        const config=await apnsCredentials(job.app_id,device.bundle_id,device.environment);
        result=config?await sendApns(config,device.token,'alert',{aps:{alert:notification,sound:'default'},...data},new Date(job.created_at).getTime()+86400000):{success:false,status:null,retryable:true};
      }else{
        const config=await pushCredentials(job.app_id);
        const ttl=Math.max(1,Math.floor((new Date(job.created_at).getTime()+86400000-Date.now())/1000));
        result=config?await sendFcm(config,device.token,data,ttl,notification):{success:false,status:null,retryable:true};
      }
      if(result.invalidToken)await db.query('DELETE FROM push_devices WHERE app_id=$1 AND installation_id=$2 AND token=$3',[job.app_id,device.installation_id,device.token]);
      await db.query(`INSERT INTO push_deliveries (app_id,message_id,installation_id,success,status_code,platform,push_type) VALUES ($1,$2,$3,$4,$5,$6,'alert')`,[job.app_id,job.message_id,device.installation_id,result.success,result.status,device.platform]);
      if(result.success || !result.retryable || job.attempts>=5){await finish(result.success?'sent':'failed');return;}
    }catch { /* Provider/database failures retry without logging sensitive payloads. */ }
    await db.query(`UPDATE message_push_jobs SET lease=NULL,available_at=NOW()+($3 * INTERVAL '1 second') WHERE id=$1 AND lease=$2`,[job.id,lease,Math.min(900,15*2**job.attempts)]);
  }));
}
export function startMessagePushWorker(isOnline:(appId:string,userId:string)=>Promise<boolean>,onError:()=>void) {
  let active:Promise<void>|undefined;
  const timer=setInterval(()=>{if(!active)active=processMessagePushJobs(isOnline).catch(onError).finally(()=>{active=undefined;});},2000);
  timer.unref();
  return async()=>{clearInterval(timer);await active;};
}
