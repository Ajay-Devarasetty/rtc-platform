import { connect, type OutgoingHttpHeaders } from 'node:http2';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { ApnsCredentials } from './push-credentials.js';

export interface PushResult { success: boolean; status: number | null; invalidToken?: boolean; retryable: boolean }
const tokens = new Map<string, { value: string; until: number }>();
// Fixed provider hosts: uploaded credential fields cannot redirect secrets elsewhere.
export const apnsTransport = {
  send(host: string, headers: OutgoingHttpHeaders, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const session = connect(host);
      let finished = false;
      const finish = (error?: Error, result?: { status: number; body: string }) => {
        if (finished) return; finished = true; clearTimeout(timer); session.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new Error('APNs timeout')), 5000);
      session.on('error', error => finish(error));
      session.on('connect', () => {
        const request = session.request(headers); let status = 0, data = '';
        request.on('response', h => { status = Number(h[':status']); });
        request.setEncoding('utf8');
        request.on('data', chunk => { data += chunk; if (data.length > 8192) finish(new Error('APNs response too large')); });
        request.on('error', error => finish(error));
        request.on('end', () => finish(undefined, { status, body: data }));
        request.end(body);
      });
    });
  }
};
export async function sendApns(credentials: ApnsCredentials, token: string, pushType: 'alert' | 'voip', payload: Record<string, unknown>, expiresAt: number): Promise<PushResult> {
  if (!/^[a-fA-F0-9]{32,512}$/.test(token)) return { success:false,status:null,invalidToken:true,retryable:false };
  const key = createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
  let cached = tokens.get(key);
  if (!cached || cached.until < Date.now()) {
    cached = { value: jwt.sign({}, credentials.privateKey, { algorithm:'ES256', keyid:credentials.keyId, issuer:credentials.teamId }), until:Date.now()+45*60_000 };
    tokens.set(key,cached);
  }
  try {
    const result = await apnsTransport.send(credentials.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', {
      ':method':'POST', ':path':`/3/device/${token}`, authorization:`bearer ${cached.value}`,
      'apns-topic':credentials.bundleId+(pushType === 'voip' ? '.voip' : ''), 'apns-push-type':pushType,
      'apns-priority':'10', 'apns-expiration':String(Math.floor(expiresAt/1000)), 'content-type':'application/json',
    }, JSON.stringify(payload));
    let reason = ''; try { reason = JSON.parse(result.body).reason; } catch { /* Success may have an empty body. */ }
    return { success:result.status === 200, status:result.status, invalidToken:result.status === 410 || reason === 'BadDeviceToken', retryable:result.status === 429 || result.status >= 500 };
  } catch { return { success:false,status:null,retryable:true }; }
}
