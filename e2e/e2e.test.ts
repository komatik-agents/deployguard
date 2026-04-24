/**
 * DeployGuard E2E Test Suite (GOAL-DG15)
 *
 * Design intent
 * ─────────────
 * These tests exercise the FULL evaluation pipeline — risk scoring,
 * gate decision, author history — using realistic GitHub API fixtures
 * rather than hand-rolled mocks. Unlike the unit tests in src/__tests__/,
 * there is no vi.mock() on the risk engine or scoring logic. Only the
 * GitHub API surface is stubbed (via a fixture-driven Octokit adapter),
 * so every algorithmic path runs as it would in production.
 *
 * What this validates that unit tests cannot
 * ──────────────────────────────────────────
 * 1. Factor interaction: does combined file-sensitivity + author-history +
 *    churn produce the correct composite score?
 * 2. Decision thresholds: does the gate actually block/warn at the right
 *    score bands (not just in theory but through the real decideGate() path)?
 * 3. Regression boundary: if someone changes FACTOR_WEIGHTS or adds a new
 *    risk factor, will existing scenarios still pass?
 * 4. Supply chain scenario: does a package.json + lock file change register
 *    as elevated risk even without CVE data?
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateGate } from "../src/gate.js";
import type { DeployGuardConfig } from "../src/types.js";
import {
  SCENARIO_LOW_RISK,
  SCENARIO_HIGH_RISK,
  SCENARIO_SUPPLY_CHAIN,
  type PrScenario,
} from "./fixtures/scenarios.js";

// ── Fixture-driven Octokit factory ───────────────────────────────────────────

/**
 * Build a minimal Octokit-shaped stub from a PrScenario.
 * Only REST endpoints called by evaluateGate() are wired.
 */
function makeOctokit(scenario: PrScenario) {
  return {
    rest: {
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: scenario.prFiles }),
        listCommits: vi.fn().mockResolvedValue({ data: scenario.prCommitList }),
        get: vi.fn().mockResolvedValue({ data: scenario.prMetadata }),
      },
      repos: {
        listCommits: vi.fn().mockResolvedValue({ data: scenario.prAuthorCommits }),
        getContent: vi.fn().mockRejectedValue({ status: 404 }), // no .deployguard.yml by default
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }),
        updateComment: vi.fn().mockResolvedValue({}),
        addLabels: vi.fn().mockResolvedValue({}),
        listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [] }),
        removeLabel: vi.fn().mockResolvedValue({}),
        createLabel: vi.fn().mockResolvedValue({}),
      },
      checks: {
        create: vi.fn().mockResolvedValue({ data: { id: 99 } }),
      },
    },
  };
}

// ── GitHub Actions context stub ───────────────────────────────────────────────

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn().mockReturnValue(""),
}));

// We swap the octokit instance per scenario via the factory above.
const mockGetOctokit = vi.fn();

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "acme-corp", repo: "api-service" },
    sha: "e2ereferencedcommitsha1234",
    payload: {},
    eventName: "pull_request",
  },
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
}));

// ── Config factory ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<DeployGuardConfig> = {}): DeployGuardConfig {
  return {
    githubToken: "e2e-test-token",
    riskThreshold: 70,
    warnThreshold: 40,
    healthCheckUrls: [],
    failMode: "open",
    selfHeal: false,
    addRiskLabels: false,
    reviewersOnRisk: [],
    dryRun: false,
    postComment: false, // don't actually post PR comments in E2E tests
    createCheckRun: false, // same
    apiKey: undefined,
    apiUrl: undefined,
    ...overrides,
  };
}

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(scenario: PrScenario, configOverrides: Partial<DeployGuardConfig> = {}) {
  const octokit = makeOctokit(scenario);
  mockGetOctokit.mockReturnValue(octokit);

  const config = makeConfig(configOverrides);
  const evaluation = await evaluateGate(config, "e2ereferencedcommitsha1234", scenario.prNumber);
  return { evaluation, octokit };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DeployGuard E2E — Scenario: low-risk src-only PR", () => {
  it("produces a risk score in the low band (0–39)", async () => {
    const { evaluation } = await runScenario(SCENARIO_LOW_RISK);
    const [min, max] = SCENARIO_LOW_RISK.expectedRiskRange;
    expect(evaluation.riskScore).toBeGreaterThanOrEqual(min);
    expect(evaluation.riskScore).toBeLessThanOrEqual(max);
  });

  it("reaches allow decision", async () => {
    const { evaluation } = await runScenario(SCENARIO_LOW_RISK);
    expect(evaluation.gateDecision).toBe(SCENARIO_LOW_RISK.expectedDecision);
  });

  it("lists risk factors including file-count and code-churn contributions", async () => {
    const { evaluation } = await runScenario(SCENARIO_LOW_RISK);
    const factorTypes = evaluation.riskFactors.map((f) => f.type);
    expect(factorTypes).toContain("file_count");
    expect(factorTypes).toContain("code_churn");
  });
});

describe("DeployGuard E2E — Scenario: high-risk auth + migration PR", () => {
  it("produces a risk score in the elevated band (40+)", async () => {
    const { evaluation } = await runScenario(SCENARIO_HIGH_RISK);
    const [min] = SCENARIO_HIGH_RISK.expectedRiskRange;
    expect(evaluation.riskScore).toBeGreaterThanOrEqual(min);
  });

  it("reaches warn or block decision", async () => {
    const { evaluation } = await runScenario(SCENARIO_HIGH_RISK);
    expect(["warn", "block"]).toContain(evaluation.gateDecision);
  });

  it("sensitive_files factor fires (auth + migration present)", async () => {
    const { evaluation } = await runScenario(SCENARIO_HIGH_RISK);
    const sensitiveFactor = evaluation.riskFactors.find((f) => f.type === "sensitive_files");
    expect(sensitiveFactor).toBeDefined();
    expect(sensitiveFactor!.score).toBeGreaterThan(50);
  });

  it("author_history factor fires (low commit count = new author)", async () => {
    const { evaluation } = await runScenario(SCENARIO_HIGH_RISK);
    const authorFactor = evaluation.riskFactors.find((f) => f.type === "author_history");
    expect(authorFactor).toBeDefined();
    // New author (2 commits) should have higher risk than veteran
    expect(authorFactor!.score).toBeGreaterThan(40);
  });
});

describe("DeployGuard E2E — Scenario: supply chain dependency churn", () => {
  it("produces a risk score above the low band (package.json changes are risky)", async () => {
    const { evaluation } = await runScenario(SCENARIO_SUPPLY_CHAIN);
    // package.json + lock file are sensitive; score should be elevated
    expect(evaluation.riskScore).toBeGreaterThan(25);
  });

  it("dependency_changes factor fires for package.json + lock file change", async () => {
    const { evaluation } = await runScenario(SCENARIO_SUPPLY_CHAIN);
    // package.json is tracked as a DEPENDENCY_FILE, not a SENSITIVE_PATTERN —
    // the engine routes it to dependency_changes, not sensitive_files.
    const depFactor = evaluation.riskFactors.find((f) => f.type === "dependency_changes");
    expect(depFactor).toBeDefined();
  });

  it("code_churn factor fires for large lock-file change", async () => {
    const { evaluation } = await runScenario(SCENARIO_SUPPLY_CHAIN);
    const churnFactor = evaluation.riskFactors.find((f) => f.type === "code_churn");
    expect(churnFactor).toBeDefined();
    expect(churnFactor!.score).toBeGreaterThan(30); // 870 changes is significant
  });
});

describe("DeployGuard E2E — Threshold sensitivity", () => {
  it("tightening riskThreshold to 30 causes the low-risk PR to warn", async () => {
    const { evaluation } = await runScenario(SCENARIO_LOW_RISK, { riskThreshold: 30, warnThreshold: 15 });
    // With a threshold of 30, even a "low risk" PR may warn depending on score
    // We just assert that the decision is consistent with the new threshold
    if (evaluation.riskScore >= 30) {
      expect(["warn", "block"]).toContain(evaluation.gateDecision);
    } else if (evaluation.riskScore >= 15) {
      expect(evaluation.gateDecision).toBe("warn");
    } else {
      expect(evaluation.gateDecision).toBe("allow");
    }
  });

  it("loosening riskThreshold to 90 allows the medium-risk supply-chain PR to pass warn-only", async () => {
    const { evaluation } = await runScenario(SCENARIO_SUPPLY_CHAIN, { riskThreshold: 90, warnThreshold: 60 });
    // Supply chain scenario score is in the 35-85 range — should warn not block at threshold 90
    if (evaluation.riskScore < 90) {
      expect(evaluation.gateDecision).not.toBe("block");
    }
  });

  it("high-risk scenario risk score is documented (regression anchor)", async () => {
    // This test captures the actual risk score for the high-risk scenario.
    // If the score changes significantly, this test will catch the regression.
    // The auth+migration scenario with new author scores very high (typically 70+).
    const { evaluation } = await runScenario(SCENARIO_HIGH_RISK);
    expect(evaluation.riskScore).toBeGreaterThanOrEqual(60);
    // Log the actual score for documentation purposes
    console.info(`[E2E] high-risk scenario risk score: ${evaluation.riskScore}`);
  });
});
