export type Instance = {
  version: string;
  /** A newer Keel release, when Studio is allowed to check (KEEL_UPDATE_CHECK). */
  update?: { check: 'on' | 'off' | 'unavailable'; latest: string | null; url: string | null };
  postgres: string;
  hostLabel: string;
  publicUrl: string;
  docker: boolean;
  backupSchedule: string;
  smtp: boolean;
  /** Studio sign-ins from the internet: allowed, refused, or only with two-factor. */
  internetLogin: 'on' | 'off' | '2fa';
};

export type ProjectSummary = { name: string; dbName: string; sizeBytes: number; createdAt: string };

export type Overview = {
  sizeBytes: number;
  tables: number;
  users: number;
  usersToday: number;
  storageBytes: number;
  buckets: number;
  lastBackup: { id: string; createdAt: string; sizeBytes: number } | null;
  backupRunning: boolean;
};

export type Column = {
  name: string;
  type: string;
  format: string;
  nullable: boolean;
  default: string | null;
  identity: boolean;
  generated: boolean;
  pk: boolean;
  fk: { schema: string; table: string; column: string } | null;
};

export type Table = {
  oid: number;
  schema: string;
  name: string;
  kind: string;
  rows: number;
  exact: boolean;
  rls: boolean;
  realtime: boolean;
  policies: number;
  comment: string | null;
  columns: Column[];
};

export type Container = {
  id: string;
  name: string;
  service: string;
  role: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  createdAt: string;
};

export type LogLine = { t: string; lvl: string; msg: string };

export type Backup = {
  id: string;
  file: string;
  size_bytes: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
};

export type Drawer =
  | { kind: 'table'; table: string }
  | { kind: 'sql'; sql?: string }
  | { kind: 'users' }
  | { kind: 'storage' }
  | { kind: 'functions'; fn?: string }
  | { kind: 'service'; service: string }
  | { kind: 'connect' }
  | { kind: 'internet' }
  | { kind: 'backups' }
  | { kind: 'cron' }
  | { kind: 'new-table' }
  | { kind: 'settings'; focus?: 'defaults' }
  | { kind: 'account' };

export type CronInfo = {
  jobs: { jobid: string; jobname: string | null; schedule: string; command: string; username: string; active: boolean; last_status: string | null; last_start: string | null; last_end: string | null; last_message: string | null }[];
  runs: { runid: string; jobid: string; status: string; return_message: string | null; start_time: string; end_time: string | null }[];
  timeoutSeconds: number;
  historyDays: number;
};

export type NetInfo = {
  queued: number;
  responses: { id: string; status_code: number | null; content_type: string | null; content: string | null; timed_out: boolean | null; error_msg: string | null; created: string }[];
  ttlHours: number;
};
