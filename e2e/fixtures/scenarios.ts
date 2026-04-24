/**
 * E2E test fixtures — realistic GitHub API response snapshots.
 *
 * These fixtures represent actual PR shapes drawn from real GitHub data
 * patterns (file diffs, author histories, metadata). They are recorded
 * once and replayed without network access, giving us realistic coverage
 * without the flakiness of live API calls.
 *
 * Three canonical scenarios exercise the full evaluation range:
 *   - SCENARIO_LOW_RISK: a clean source-only PR that should pass
 *   - SCENARIO_HIGH_RISK: a security-sensitive PR that should warn/block
 *   - SCENARIO_SUPPLY_CHAIN: a dependency-heavy PR with new packages added
 */

// ── Types mirroring the shapes @octokit/rest returns ─────────────────────────

export interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface CommitEntry {
  sha: string;
  commit: { message: string };
}

export interface PrMetadata {
  user: { login: string };
  created_at: string;
}

export interface PrScenario {
  name: string;
  description: string;
  prNumber: number;
  prFiles: PrFile[];
  prAuthorCommits: CommitEntry[];    // recent commits by this author
  prCommitList: CommitEntry[];        // commits on this PR
  prMetadata: PrMetadata;
  expectedDecision: "allow" | "warn" | "block";
  expectedRiskRange: [number, number]; // [min, max] inclusive
}

// ── SCENARIO 1: Low-risk source PR ───────────────────────────────────────────

export const SCENARIO_LOW_RISK: PrScenario = {
  name: "low-risk-src-only",
  description:
    "A well-scoped refactor PR: source + tests, no sensitive files, experienced author, small churn.",
  prNumber: 42,
  prFiles: [
    {
      filename: "src/utils/formatter.ts",
      additions: 28,
      deletions: 12,
      changes: 40,
      patch:
        "@@ -1,12 +1,28 @@\n-export function fmt(v: number) { return v.toFixed(2); }\n+export function formatCurrency(value: number, currency = 'USD'): string {\n+  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);\n+}",
    },
    {
      filename: "src/utils/__tests__/formatter.test.ts",
      additions: 22,
      deletions: 4,
      changes: 26,
    },
    {
      filename: "docs/formatting.md",
      additions: 15,
      deletions: 0,
      changes: 15,
    },
  ],
  prAuthorCommits: Array.from({ length: 24 }, (_, i) => ({
    sha: `veteran-commit-${i}`,
    commit: { message: `feat: shipping iteration ${i}` },
  })),
  prCommitList: [
    { sha: "feat-abc1", commit: { message: "feat: improved formatter" } },
    { sha: "test-abc2", commit: { message: "test: add formatter coverage" } },
  ],
  prMetadata: {
    user: { login: "alice-dev" },
    created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
  },
  expectedDecision: "allow",
  expectedRiskRange: [0, 39],
};

// ── SCENARIO 2: High-risk security-sensitive PR ───────────────────────────────

export const SCENARIO_HIGH_RISK: PrScenario = {
  name: "high-risk-auth-change",
  description:
    "A PR touching authentication, migrations, and environment config — all high-sensitivity files. " +
    "New author with minimal commit history. Large churn.",
  prNumber: 117,
  prFiles: [
    {
      filename: "src/auth/jwt.ts",
      additions: 95,
      deletions: 30,
      changes: 125,
      patch:
        "@@ -1,30 +1,95 @@\n-// old JWT handling\n+import { sign, verify } from 'jsonwebtoken';\n+export function signToken(payload: object, secret: string): string {\n+  return sign(payload, secret, { expiresIn: '7d' });\n+}",
    },
    {
      filename: "migrations/20260424_add_sessions.sql",
      additions: 48,
      deletions: 0,
      changes: 48,
      patch:
        "@@ -0,0 +1,48 @@\n+CREATE TABLE user_sessions (\n+  id UUID PRIMARY KEY,\n+  user_id UUID NOT NULL REFERENCES users(id),\n+  token_hash TEXT NOT NULL,\n+  created_at TIMESTAMPTZ DEFAULT NOW()\n+);",
    },
    {
      filename: "src/middleware/auth.ts",
      additions: 62,
      deletions: 15,
      changes: 77,
    },
    {
      filename: ".env.example",
      additions: 8,
      deletions: 2,
      changes: 10,
      patch: "@@ -1,5 +1,10 @@\n+JWT_SECRET=your-secret-key\n+SESSION_EXPIRY=86400\n+REFRESH_TOKEN_SECRET=another-secret",
    },
    {
      filename: "src/utils/crypto.ts",
      additions: 40,
      deletions: 0,
      changes: 40,
    },
  ],
  prAuthorCommits: [
    { sha: "new-author-1", commit: { message: "initial commit" } },
    { sha: "new-author-2", commit: { message: "fix: typo" } },
  ], // low history = new/unfamiliar author
  prCommitList: [
    { sha: "auth-overhaul-1", commit: { message: "feat: auth overhaul" } },
    { sha: "auth-overhaul-2", commit: { message: "fix: session handling" } },
    { sha: "auth-overhaul-3", commit: { message: "chore: env vars" } },
  ],
  prMetadata: {
    user: { login: "contractor-xr" },
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago = fresh PR
  },
  expectedDecision: "warn",
  expectedRiskRange: [40, 100],
};

// ── SCENARIO 3: Supply chain churn (dependency heavy) ─────────────────────────

export const SCENARIO_SUPPLY_CHAIN: PrScenario = {
  name: "supply-chain-deps",
  description:
    "A PR that adds 4 new npm packages including one at a suspiciously fresh version. " +
    "Package-lock changes are large. Tests for new packages present but thin.",
  prNumber: 203,
  prFiles: [
    {
      filename: "package.json",
      additions: 12,
      deletions: 1,
      changes: 13,
      patch:
        '@@ -15,7 +15,18 @@\n   "dependencies": {\n-    "axios": "^1.6.0"\n+    "axios": "^1.8.4",\n+    "zod": "^3.22.0",\n+    "@sentry/node": "^8.0.1",\n+    "pdf-lib": "^1.17.1",\n+    "freshpackage": "^0.0.1"\n   }',
    },
    {
      filename: "package-lock.json",
      additions: 847,
      deletions: 23,
      changes: 870,
    },
    {
      filename: "src/validation/schema.ts",
      additions: 34,
      deletions: 0,
      changes: 34,
      patch:
        "@@ -0,0 +1,34 @@\n+import { z } from 'zod';\n+export const UserSchema = z.object({ id: z.string().uuid(), email: z.string().email() });",
    },
    {
      filename: "src/errors/sentry.ts",
      additions: 18,
      deletions: 0,
      changes: 18,
    },
    {
      filename: "src/__tests__/schema.test.ts",
      additions: 15,
      deletions: 0,
      changes: 15,
    },
  ],
  prAuthorCommits: Array.from({ length: 8 }, (_, i) => ({
    sha: `mid-commit-${i}`,
    commit: { message: `chore: iteration ${i}` },
  })),
  prCommitList: [
    { sha: "deps-add-1", commit: { message: "feat: add validation + sentry" } },
    { sha: "deps-add-2", commit: { message: "deps: lock file update" } },
  ],
  prMetadata: {
    user: { login: "bob-infra" },
    created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4h old
  },
  expectedDecision: "warn",
  expectedRiskRange: [35, 85],
};

export const ALL_SCENARIOS = [SCENARIO_LOW_RISK, SCENARIO_HIGH_RISK, SCENARIO_SUPPLY_CHAIN];
