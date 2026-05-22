export type ClientKeyType = 'ip' | 'api_key' | 'user_id';
export type Strategy = 'sliding_window' | 'fixed_window';

export interface Rule {
  id: string;
  routePattern: string;
  clientKeyType: ClientKeyType;
  limitCount: number;
  windowSeconds: number;
  strategy: Strategy;
  enabled: boolean;
  createdAt: string;
}

export interface CreateRuleInput {
  routePattern: string;
  clientKeyType: ClientKeyType;
  limitCount: number;
  windowSeconds: number;
  strategy?: Strategy;
  enabled?: boolean;
}

export interface CheckRequest {
  route: string;
  clientKey: string;
}

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  windowSeconds: number;
  resetAt: number;
  retryAfter?: number;
  message?: string;
}

export interface StatsResult {
  clientKey: string;
  windowSeconds: number;
  requestCount: number;
  limit: number;
  remaining: number;
  resetAt: number;
}
