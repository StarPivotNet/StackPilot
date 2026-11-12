type ParentPageKey =
  | "overview"
  | "hosts"
  | "sites"
  | "databases"
  | "files"
  | "terminal"
  | "ssh"
  | "systemd"
  | "firewall"
  | "deploy"
  | "schedule"
  | "audit"
  | "acl"
  | "settings";

type PageKey = string;

type Tone = "green" | "blue" | "orange" | "red" | "gray" | "purple";

type ToastTone = "success" | "info" | "warning" | "danger";

type ToastState = { message: string; tone: ToastTone };

type Notify = (message: string, tone?: ToastTone) => void;

type SetPage = (page: PageKey, toast?: ToastState) => void;

type SettingsReadOnlyState = {
  readOnly: boolean;
  setReadOnly: React.Dispatch<React.SetStateAction<boolean>>;
};

type QuickIntent = "create-site" | "open-terminal" | "create-schedule" | "create-database";

type AuditSource = "database";

type PageMeta = { title: string; breadcrumb: string; search: string };

type ViewContext = { eyebrow: string; title: string; chips: string[] };

export type { ParentPageKey, PageKey, Tone, ToastTone, ToastState, Notify, SetPage, SettingsReadOnlyState, QuickIntent, AuditSource, PageMeta, ViewContext };
