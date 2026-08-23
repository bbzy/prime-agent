import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const AGENT_CYCLE_MIN_INTERVAL_MS = 30_000;
export const AGENT_CYCLE_MAX_CONSECUTIVE_FAILURES = 5;
export const AGENT_CYCLE_MAX_DRY_ROUNDS = 2;
export const AGENT_CYCLE_MAX_POST_REFLECTION_DRY_ROUNDS = 1;
export const AGENT_CYCLE_MAX_CONSECUTIVE_DUPLICATE_RESPONSES = 3;
export const AGENT_CYCLE_MAX_CONSECUTIVE_EMPTY_RESPONSES = 2;
export const DEFAULT_AGENT_CYCLE_PROMPT = "Continue owning and advancing the current task.";

export type AgentCyclePauseReason =
	| "user_paused"
	| "user_intervention"
	| "iteration_interrupted"
	| "post_reflection_dry"
	| "duplicate_response"
	| "consecutive_failures"
	| "empty_response";

export type AgentCycleRoundOutcome = "activity" | "dry" | "reflection" | "failure" | "empty" | "interrupted";

export interface AgentCycleState {
	rounds: number;
	successfulRounds: number;
	failedRounds: number;
	interruptedRounds: number;
	consecutiveFailures: number;
	consecutiveDryRounds: number;
	postReflection: boolean;
	consecutiveDuplicateResponses: number;
	consecutiveEmptyResponses: number;
	startedAt: string;
	lastOutcome?: AgentCycleRoundOutcome;
	lastResponseFingerprint?: string;
	pauseReason?: AgentCyclePauseReason;
	lastError?: string;
}

export type AgentCycleUpdateAction = "pause" | "resume" | "run" | "stop";

export type ParsedCycleCommand =
	| { type: "help" }
	| { type: "status" }
	| { type: AgentCycleUpdateAction }
	| { type: "set"; schedule: string; intervalMs: number; intervalLabel: string };

export type AgentCycleRoundObservation =
	| {
			kind: "completed";
			usedTool: boolean;
			empty: boolean;
			response: string;
			reflection: boolean;
	  }
	| { kind: "failure"; error: string; reflection: boolean }
	| {
			kind: "interrupted";
			reason: "user_intervention" | "iteration_interrupted";
			reflection: boolean;
	  };

export interface AgentCycleRoundTransition {
	cycle: AgentCycleState;
	status: "active" | "paused" | "cancelled";
}

export interface ParsedCycleSchedule {
	schedule: { kind: "interval"; expression: string; intervalMs: number };
	nextRunAt: Date;
}

const DURATION_PATTERN = /^(?:\d+\s*(?:ms|s|m|h)\s*)+$/i;
const DURATION_PART_PATTERN = /(\d+)\s*(ms|s|m|h)/gi;

export function parseAgentCycleDuration(input: string): number | undefined {
	const text = input.trim();
	if (!text || !DURATION_PATTERN.test(text)) return undefined;
	const multipliers: Record<string, number> = {
		ms: 1,
		s: 1000,
		m: 60_000,
		h: 3_600_000,
	};
	let total = 0;
	for (const match of text.matchAll(DURATION_PART_PATTERN)) {
		const amount = Number.parseInt(match[1]!, 10);
		total += amount * multipliers[match[2]!.toLowerCase()]!;
	}
	return total > 0 ? total : undefined;
}

export function parseAgentCycleSchedule(input: string, now = new Date()): ParsedCycleSchedule {
	const text = input.trim().replace(/^every\s+/i, "");
	const intervalMs = parseAgentCycleDuration(text);
	if (!intervalMs) {
		throw new Error('Invalid Cycle interval. Use a duration such as "30s", "5m", "1h", or "2h30m".');
	}
	if (intervalMs < AGENT_CYCLE_MIN_INTERVAL_MS) {
		throw new Error(`Cycle interval must be at least ${AGENT_CYCLE_MIN_INTERVAL_MS / 1000}s.`);
	}
	return {
		schedule: { kind: "interval", expression: `every ${text}`, intervalMs },
		nextRunAt: new Date(now.getTime() + intervalMs),
	};
}

export function parseCycleCommand(input: string): ParsedCycleCommand {
	const text = input.replace(/^\/(?:cycle|loop)\b/i, "").trim();
	if (!text || text === "help") return { type: "help" };
	if (text === "status") return { type: "status" };
	if (text === "pause" || text === "resume" || text === "run" || text === "stop") {
		return { type: text };
	}

	const parts = text.split(/\s+/);
	const duration = parts[0] === "start" ? parts[1] : parts[0];
	const extra = parts[0] === "start" ? parts.slice(2) : parts.slice(1);
	if (!duration) {
		throw new Error("Usage: /cycle [start] <interval>");
	}
	if (duration === "at") {
		throw new Error("Cycle only supports intervals; clock-time schedules are not supported.");
	}
	if (extra.length > 0) {
		throw new Error(`Unexpected argument: "${extra[0]}". Usage: /cycle [start] <interval>`);
	}
	const parsed = parseAgentCycleSchedule(duration);
	return {
		type: "set",
		schedule: parsed.schedule.expression,
		intervalMs: parsed.schedule.intervalMs,
		intervalLabel: duration,
	};
}

export function createInitialAgentCycleState(now = new Date()): AgentCycleState {
	return {
		rounds: 0,
		successfulRounds: 0,
		failedRounds: 0,
		interruptedRounds: 0,
		consecutiveFailures: 0,
		consecutiveDryRounds: 0,
		postReflection: false,
		consecutiveDuplicateResponses: 0,
		consecutiveEmptyResponses: 0,
		startedAt: now.toISOString(),
	};
}

export function isAgentCycleReflectionRound(cycle: AgentCycleState): boolean {
	return !cycle.postReflection && cycle.consecutiveDryRounds >= AGENT_CYCLE_MAX_DRY_ROUNDS;
}

export function createAgentCyclePrompt(
	input: { prompt: string; cycle: AgentCycleState; schedule: { expression: string } },
	now = new Date(),
): string {
	const round = input.cycle.rounds + 1;
	const reflection = isAgentCycleReflectionRound(input.cycle);
	const lines = [
		`[Cycle #${round}] Automated ownership round. ${now.toISOString()}`,
		"Continue naturally from the visible session and persistent IPython state.",
		"If the cycle-owner contract is not already visible, load the cycle-owner skill now; otherwise do not reload it.",
		`Responsibility: ${input.prompt}`,
	];
	if (input.cycle.postReflection) {
		lines.push(
			`Post-reflection tool activity: ${input.cycle.consecutiveDryRounds}/${AGENT_CYCLE_MAX_POST_REFLECTION_DRY_ROUNDS} completed rounds without a tool call. Any tool call returns Cycle to normal operation.`,
		);
	} else if (input.cycle.consecutiveDryRounds > 0) {
		lines.push(
			`Tool activity: ${input.cycle.consecutiveDryRounds}/${AGENT_CYCLE_MAX_DRY_ROUNDS} completed rounds without a tool call before reflection.`,
		);
	}
	if (reflection) {
		lines.push(
			"Reflection trigger: reassess the current objective, recent evidence, and whether the approach is drifting or repeating. Do not manufacture changes. Choose the best corrected next action and execute it if safe. This reflection round is excluded from inactivity counting.",
		);
	}
	return lines.join("\n");
}

export function observeAgentCycleRound(
	messages: readonly AgentMessage[],
	reflection: boolean,
): AgentCycleRoundObservation {
	if (messages.some((message) => message.role === "user")) {
		return { kind: "interrupted", reason: "user_intervention", reflection };
	}
	const assistants = messages.filter((message): message is AssistantMessage => message.role === "assistant");
	if (assistants.some((message) => message.stopReason === "aborted")) {
		return { kind: "interrupted", reason: "iteration_interrupted", reflection };
	}
	let failed: AssistantMessage | undefined;
	for (let index = assistants.length - 1; index >= 0; index--) {
		if (assistants[index]!.stopReason === "error") {
			failed = assistants[index];
			break;
		}
	}
	if (failed) {
		return {
			kind: "failure",
			error: failed.errorMessage?.trim() || failed.stopReasonRaw?.trim() || "Cycle round failed",
			reflection,
		};
	}
	const terminal = assistants.at(-1);
	const usedTool = assistants.some((message) => message.content.some((content) => content.type === "toolCall"));
	const response =
		terminal?.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim() ?? "";
	const hasOutput = assistants.some((message) => message.content.length > 0 || message.usage.output > 0);
	return { kind: "completed", usedTool, empty: !hasOutput, response, reflection };
}

export function advanceAgentCycle(
	current: AgentCycleState,
	observation: AgentCycleRoundObservation,
): AgentCycleRoundTransition {
	const cycle: AgentCycleState = {
		...current,
		rounds: current.rounds + 1,
		pauseReason: undefined,
	};
	if (observation.kind === "interrupted") {
		return {
			status: "paused",
			cycle: {
				...cycle,
				interruptedRounds: cycle.interruptedRounds + 1,
				consecutiveDuplicateResponses: 0,
				lastResponseFingerprint: undefined,
				lastOutcome: "interrupted",
				pauseReason: observation.reason,
			},
		};
	}
	if (observation.kind === "failure") {
		const consecutiveFailures = cycle.consecutiveFailures + 1;
		return {
			status: consecutiveFailures >= AGENT_CYCLE_MAX_CONSECUTIVE_FAILURES ? "cancelled" : "active",
			cycle: {
				...cycle,
				failedRounds: cycle.failedRounds + 1,
				consecutiveFailures,
				consecutiveDuplicateResponses: 0,
				lastResponseFingerprint: undefined,
				lastOutcome: "failure",
				lastError: observation.error.slice(0, 200),
				...(consecutiveFailures >= AGENT_CYCLE_MAX_CONSECUTIVE_FAILURES
					? { pauseReason: "consecutive_failures" as const }
					: {}),
			},
		};
	}
	if (observation.empty) {
		const consecutiveEmptyResponses = cycle.consecutiveEmptyResponses + 1;
		return {
			status: consecutiveEmptyResponses >= AGENT_CYCLE_MAX_CONSECUTIVE_EMPTY_RESPONSES ? "cancelled" : "active",
			cycle: {
				...cycle,
				failedRounds: cycle.failedRounds + 1,
				consecutiveEmptyResponses,
				consecutiveDuplicateResponses: 0,
				lastResponseFingerprint: undefined,
				lastOutcome: "empty",
				lastError: "Empty response from provider",
				...(consecutiveEmptyResponses >= AGENT_CYCLE_MAX_CONSECUTIVE_EMPTY_RESPONSES
					? { pauseReason: "empty_response" as const }
					: {}),
			},
		};
	}

	const successful: AgentCycleState = {
		...cycle,
		successfulRounds: cycle.successfulRounds + 1,
		consecutiveFailures: 0,
		consecutiveEmptyResponses: 0,
		lastError: undefined,
	};
	if (observation.reflection) {
		return {
			status: "active",
			cycle: {
				...successful,
				consecutiveDryRounds: 0,
				postReflection: true,
				consecutiveDuplicateResponses: 0,
				lastResponseFingerprint: undefined,
				lastOutcome: "reflection",
			},
		};
	}
	if (observation.usedTool) {
		return {
			status: "active",
			cycle: {
				...successful,
				consecutiveDryRounds: 0,
				postReflection: false,
				consecutiveDuplicateResponses: 0,
				lastResponseFingerprint: undefined,
				lastOutcome: "activity",
			},
		};
	}

	const fingerprint = responseFingerprint(observation.response);
	const consecutiveDuplicateResponses = fingerprint
		? fingerprint === successful.lastResponseFingerprint
			? successful.consecutiveDuplicateResponses + 1
			: 1
		: 0;
	const consecutiveDryRounds = successful.consecutiveDryRounds + 1;
	const duplicatePause =
		successful.postReflection && consecutiveDuplicateResponses >= AGENT_CYCLE_MAX_CONSECUTIVE_DUPLICATE_RESPONSES;
	const dryPause = successful.postReflection && consecutiveDryRounds >= AGENT_CYCLE_MAX_POST_REFLECTION_DRY_ROUNDS;
	return {
		status: duplicatePause || dryPause ? "paused" : "active",
		cycle: {
			...successful,
			consecutiveDryRounds,
			consecutiveDuplicateResponses,
			lastResponseFingerprint: fingerprint,
			lastOutcome: "dry",
			...(duplicatePause
				? { pauseReason: "duplicate_response" as const }
				: dryPause
					? { pauseReason: "post_reflection_dry" as const }
					: {}),
		},
	};
}

export function resetAgentCycleLiveness(cycle: AgentCycleState): AgentCycleState {
	return {
		...cycle,
		consecutiveFailures: 0,
		consecutiveDryRounds: 0,
		postReflection: false,
		consecutiveDuplicateResponses: 0,
		consecutiveEmptyResponses: 0,
		lastResponseFingerprint: undefined,
		pauseReason: undefined,
	};
}

export function agentCyclePauseReasonText(reason: AgentCyclePauseReason | undefined): string | undefined {
	switch (reason) {
		case "user_paused":
			return "paused by user";
		case "user_intervention":
			return "user intervention";
		case "iteration_interrupted":
			return "iteration interrupted";
		case "post_reflection_dry":
			return `${AGENT_CYCLE_MAX_POST_REFLECTION_DRY_ROUNDS} post-reflection round without a tool call`;
		case "duplicate_response":
			return `${AGENT_CYCLE_MAX_CONSECUTIVE_DUPLICATE_RESPONSES} materially identical responses`;
		case "consecutive_failures":
			return `${AGENT_CYCLE_MAX_CONSECUTIVE_FAILURES} consecutive failures`;
		case "empty_response":
			return `${AGENT_CYCLE_MAX_CONSECUTIVE_EMPTY_RESPONSES} consecutive empty responses`;
		case undefined:
			return undefined;
	}
}

export function isAgentCycleState(value: unknown): value is AgentCycleState {
	if (!value || typeof value !== "object") return false;
	const cycle = value as Partial<AgentCycleState>;
	const counts = [
		cycle.rounds,
		cycle.successfulRounds,
		cycle.failedRounds,
		cycle.interruptedRounds,
		cycle.consecutiveFailures,
		cycle.consecutiveDryRounds,
		cycle.consecutiveDuplicateResponses,
		cycle.consecutiveEmptyResponses,
	];
	return (
		counts.every((count) => Number.isInteger(count) && (count ?? -1) >= 0) &&
		typeof cycle.postReflection === "boolean" &&
		typeof cycle.startedAt === "string" &&
		(cycle.lastOutcome === undefined ||
			cycle.lastOutcome === "activity" ||
			cycle.lastOutcome === "dry" ||
			cycle.lastOutcome === "reflection" ||
			cycle.lastOutcome === "failure" ||
			cycle.lastOutcome === "empty" ||
			cycle.lastOutcome === "interrupted") &&
		(cycle.lastResponseFingerprint === undefined || typeof cycle.lastResponseFingerprint === "string") &&
		(cycle.pauseReason === undefined || agentCyclePauseReasonText(cycle.pauseReason) !== undefined) &&
		(cycle.lastError === undefined || typeof cycle.lastError === "string")
	);
}

function responseFingerprint(response: string): string | undefined {
	const normalized = response
		.replace(/#\d+(?:-\d+)?/g, "#")
		.replace(/\b(?:iteration|round)\s+\d+\b/gi, "round #")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	if (!normalized) return undefined;
	return createHash("sha256").update(normalized).digest("hex");
}
