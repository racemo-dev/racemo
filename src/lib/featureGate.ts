type Plan = "starter" | "pro";

type Feature =
  | "remote_access"
  | "account_devices"
  | "cloud_sync"
  | "notifications"
  | "multi_device";

const FEATURE_REQUIREMENTS: Record<Feature, Plan> = {
  remote_access: "pro",
  account_devices: "pro",
  cloud_sync: "pro",
  notifications: "pro",
  multi_device: "pro",
};

const FEATURE_LABELS: Record<Feature, string> = {
  remote_access: "Remote Access",
  account_devices: "Account-linked Devices",
  cloud_sync: "Cloud Sync",
  notifications: "Real-time Notifications",
  multi_device: "Multi-device Sync",
};

export function canAccess(feature: Feature, plan: Plan | undefined): boolean {
  if (!plan) return false;
  const required = FEATURE_REQUIREMENTS[feature];
  if (required === "starter") return true;
  return plan === "pro";
}

export function getFeatureLabel(feature: Feature): string {
  return FEATURE_LABELS[feature];
}

export function getRequiredPlan(feature: Feature): Plan {
  return FEATURE_REQUIREMENTS[feature];
}

export type { Feature, Plan };
