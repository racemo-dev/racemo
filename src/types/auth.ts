export interface AuthUser {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  plan: "starter" | "pro";
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  status: string;
  access_token?: string;
  refresh_token?: string;
  user?: AuthUser;
  message?: string;
}
