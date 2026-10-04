export type PushDeviceRegistration = {
  installationId:string; token:string; appState?:'foreground'|'background';
} & ({platform?:'android';pushType?:'alert'} | {platform:'ios';pushType:'alert'|'voip';bundleId:string;environment:'sandbox'|'production'});

/** Uses a short-lived RTC user token, never an app secret or portal session.
 * Host app supplies native FCM/APNs tokens and owns permission/CallKit handling.
 */
export class RTCPushClient {
  constructor(private serverUrl:string,private getToken:()=>string|Promise<string>) {}
  private async request(path:string,method:string,body?:unknown) {
    const response=await fetch(`${this.serverUrl.replace(/\/$/,'')}/v1/${path}`,{
      method,headers:{Authorization:`Bearer ${await this.getToken()}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    if(!response.ok)throw new Error(`Push request failed (${response.status})`);
  }
  registerDevice(device:PushDeviceRegistration){return this.request('push/devices','POST',device);}
  setAppState(installationId:string,appState:'foreground'|'background'){return this.request(`push/devices/${encodeURIComponent(installationId)}`,'PATCH',{appState});}
  unregisterDevice(installationId:string){return this.request(`push/devices/${encodeURIComponent(installationId)}`,'DELETE');}
  /** Call after roomJoined. Survives socket disconnect; leaveRoom unsubscribes. */
  subscribeToRoom(roomId:string){return this.request(`rooms/${encodeURIComponent(roomId)}/notifications`,'PUT');}
  unsubscribeFromRoom(roomId:string){return this.request(`rooms/${encodeURIComponent(roomId)}/notifications`,'DELETE');}
}
