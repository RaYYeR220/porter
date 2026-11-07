/** Otari guardrail HTTP protocol plus the shared types of this package. */

export type ValidateRequest = {
  profile: string;
  input_text: string;
  validate_kwargs?: Record<string, unknown>;
};

export type ValidateResponse = {
  profile: string;
  result: { valid: boolean; explanation: string; score: number };
};

export type ProfileName = "prompt-injection" | "secrets" | "harm";

export const PROFILES: ReadonlyArray<{ name: ProfileName; description: string }> = [
  {
    name: "prompt-injection",
    description: "Instructions aimed at an AI agent hidden in untrusted text: role blocks, hidden comments, tool bait, exfiltration links.",
  },
  { name: "secrets", description: "Credentials pasted into text: GitHub tokens, AWS keys, API keys, private keys." },
  { name: "harm", description: "Harmful content (violence, abuse, illegal activity) per Llama Guard 4." },
];

export type SignalId =
  | "hidden_html_comment"
  | "zero_width"
  | "bidi_override"
  | "base64_blob"
  | "role_block"
  | "ignore_previous"
  | "tool_bait"
  | "exfil_link"
  | "secret_github_token"
  | "secret_aws_key"
  | "secret_api_key"
  | "secret_private_key";

/** excerpt is a locator ("offset=N len=M"), never raw input text. */
export type Signal = { id: SignalId; excerpt: string };

export type ModelVerdict = {
  model: string;
  flagged: boolean | null;
  score: number | null;
  latencyMs: number;
  error?: string;
};

export type Decision = { valid: boolean; score: number; explanation: string };

/** Minimal chat access the guard needs. Injected so the package never depends on the app. */
export type ChatFn = (body: {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature?: number;
}) => Promise<{ content: string }>;

export type GuardLog = {
  inputSha256: string;
  profile: string;
  valid: boolean;
  score: number;
  explanation: string;
  signals: Signal[];
  modelVerdicts: ModelVerdict[];
  latencyMs: number;
};

export const MODELS = {
  qwen: "alibaba/qwen3guard-gen-8b",
  safeguard: "openai/gpt-oss-safeguard-120b",
  llamaGuard: "meta/llama-guard-4-12b",
} as const;
