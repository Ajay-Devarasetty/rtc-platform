/** Import this into YOUR authenticated backend. Never bundle it into a client app. */
export async function tokenForAuthenticatedUser(user, roomId, authorizeRoom) {
  if (!user?.id || typeof roomId !== 'string' || !await authorizeRoom(user.id, roomId)) {
    throw new Error('Room access denied');
  }
  const { RTC_SERVER_URL, RTC_APP_ID, RTC_APP_SECRET } = process.env;
  if (!RTC_SERVER_URL || !RTC_APP_ID || !RTC_APP_SECRET) throw new Error('RTC backend environment is incomplete');
  const response = await fetch(`${RTC_SERVER_URL.replace(/\/$/, '')}/v1/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: RTC_APP_ID, appSecret: RTC_APP_SECRET, userId: String(user.id), roomId, role: 'publisher' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`RTC token request failed (${response.status})`);
  return response.json();
}
