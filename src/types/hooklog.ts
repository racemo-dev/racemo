export interface HookTreeNode {
  id: string;
  node_type: string;
  label: string;
  timestamp: string;
  status: string;
  detail: string;
  raw: string;
  model: string;
  children: HookTreeNode[];
}
