const API = "";

export function getAdminKey() {
  return sessionStorage.getItem("rtc_admin_key") || "";
}

export function setAdminKey(key: string) {
  sessionStorage.setItem("rtc_admin_key", key);
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": getAdminKey(),
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export interface AppRecord {
  appId: string;
  name: string;
  active: boolean;
  plan?: string;
  createdAt: string;
}

export interface WebhookRecord {
  id: string;
  appId: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
}

export interface EventRecord {
  id: number;
  type: string;
  roomId: string | null;
  userId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface DeliveryRecord {
  id: number;
  webhookId: string;
  eventId: number | null;
  eventType: string | null;
  statusCode: number | null;
  success: boolean;
  error: string | null;
  attempt: number;
  createdAt: string;
}

export interface MeteringSummary {
  appId: string;
  messagesSent: number;
  callsConnected: number;
  callsEnded: number;
  callMinutes: number;
  totalEvents: number;
}

export interface QualityReport {
  id: number;
  callId: string | null;
  roomId: string;
  userId: string;
  mediaMode: string;
  qualityScore: number;
  qualityLabel: string;
  rttMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  createdAt: string;
}

export interface QualitySummary {
  appId: string;
  reportCount: number;
  avgScore: number;
  poorCount: number;
  fairCount: number;
  goodCount: number;
  excellentCount: number;
  avgRttMs: number | null;
  avgPacketLossPct: number | null;
}

export interface BillingSummary {
  appId: string;
  plan: string;
  planName: string;
  planDescription?: string;
  features?: Record<string, boolean>;
  usage: {
    callMinutes: number;
    messagesSent: number;
    recordings: number;
    transcriptionMinutes: number;
    qualityReports: number;
  };
  limits: Record<string, number>;
  limitStatus: Record<string, { used: number; limit: number; percent: number; exceeded: boolean }>;
  estimatedCostUsd: number;
  overageCostUsd: number;
}

export const api = {
  listApps: () => adminFetch<{ apps: AppRecord[] }>("/v1/admin/apps"),
  createApp: (name: string) =>
    adminFetch<{ appId: string; appSecret: string; name: string; note?: string }>(
      "/v1/admin/apps",
      { method: "POST", body: JSON.stringify({ name }) }
    ),
  listWebhooks: (appId: string) =>
    adminFetch<{ webhooks: WebhookRecord[] }>(`/v1/admin/apps/${appId}/webhooks`),
  createWebhook: (appId: string, url: string, events: string[]) =>
    adminFetch<{ id: string; secret: string; url: string; eventTypes: string[] }>(
      `/v1/admin/apps/${appId}/webhooks`,
      { method: "POST", body: JSON.stringify({ url, events }) }
    ),
  deleteWebhook: (appId: string, webhookId: string) =>
    adminFetch<{ ok: boolean }>(`/v1/admin/apps/${appId}/webhooks/${webhookId}`, {
      method: "DELETE",
    }),
  toggleWebhook: (appId: string, webhookId: string, active: boolean) =>
    adminFetch<WebhookRecord>(`/v1/admin/apps/${appId}/webhooks/${webhookId}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    }),
  listEvents: (appId: string, limit = 50) =>
    adminFetch<{ events: EventRecord[] }>(`/v1/admin/apps/${appId}/events?limit=${limit}`),
  listDeliveries: (appId: string, limit = 50) =>
    adminFetch<{ deliveries: DeliveryRecord[] }>(
      `/v1/admin/apps/${appId}/webhook-deliveries?limit=${limit}`
    ),
  getMetering: (appId: string) =>
    adminFetch<MeteringSummary>(`/v1/admin/apps/${appId}/metering`),
  getUsage: (appId: string) =>
    adminFetch<{ totalEvents: number; byType: Array<{ type: string; count: number }> }>(
      `/v1/admin/apps/${appId}/usage`
    ),
  eventTypes: () =>
    adminFetch<{ eventTypes: string[] }>("/v1/admin/webhook-event-types"),
  listQualityReports: (appId: string, limit = 50) =>
    adminFetch<{ reports: QualityReport[] }>(`/v1/admin/apps/${appId}/quality?limit=${limit}`),
  getQualitySummary: (appId: string) =>
    adminFetch<QualitySummary>(`/v1/admin/apps/${appId}/quality/summary`),
  getBilling: (appId: string) =>
    adminFetch<BillingSummary>(`/v1/admin/apps/${appId}/billing`),
  setPlan: (appId: string, plan: string) =>
    adminFetch<{ appId: string; plan: string }>(`/v1/admin/apps/${appId}/plan`, {
      method: "PATCH",
      body: JSON.stringify({ plan }),
    }),
  listPlans: () =>
    adminFetch<{ plans: Record<string, { name: string; limits: Record<string, number> }> }>(
      "/v1/admin/billing/plans"
    ),
};
