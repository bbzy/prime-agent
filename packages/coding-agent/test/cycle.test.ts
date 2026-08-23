import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore, AgentCronScheduler } from "../src/core/cron-jobs.js";
import {
	advanceAgentCycle,
	createAgentCyclePrompt,
	createInitialAgentCycleState,
	isAgentCycleReflectionRound,
	observeAgentCycleRound,
	parseAgentCycleDuration,
	parseCycleCommand,
} from "../src/core/cycle.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createStore(): AgentCronJobStore {
	const dir = mkdtempSync(join(tmpdir(), "prime-cycle-test-"));
	tempDirs.push(dir);
	return new AgentCronJobStore(join(dir, "scheduled-jobs.json"));
}

function usage(output: number): Usage {
	return {
		input: 1,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1 + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
	options: { output?: number; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock-api",
		provider: "mock-provider",
		model: "mock-model",
		usage: usage(options.output ?? 1),
		stopReason,
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

describe("Cycle command parsing", () => {
	it("accepts simple and compound interval syntax", () => {
		expect(parseAgentCycleDuration("2h30m")).toBe(9_000_000);
		expect(parseCycleCommand("/cycle 5m")).toEqual({
			type: "set",
			schedule: "every 5m",
			intervalMs: 300_000,
			intervalLabel: "5m",
		});
		expect(parseCycleCommand("/loop start 30s")).toMatchObject({ type: "set", schedule: "every 30s" });
	});

	it("rejects clock schedules, short intervals, and extra arguments", () => {
		expect(() => parseCycleCommand("/cycle at 12:00")).toThrow("only supports intervals");
		expect(() => parseCycleCommand("/cycle 10s")).toThrow("at least 30s");
		expect(() => parseCycleCommand("/cycle 5m change files")).toThrow("Unexpected argument");
	});
});

describe("Cycle persistence and scheduling", () => {
	const input = {
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.jsonl",
		cwd: "/tmp/project",
		runtimeKind: "top-level" as const,
	};

	it("replaces the active Cycle and anchors the next run to round completion", () => {
		const store = createStore();
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		const first = store.createCycle({ ...input, scheduleText: "every 5m", now: startedAt });
		const replacement = store.createCycle({ ...input, scheduleText: "every 5m", now: startedAt });

		expect(store.list().find((job) => job.id === first.id)?.status).toBe("cancelled");
		expect(replacement).toMatchObject({ source: "cycle", status: "active", runCount: 0 });
		expect(store.getLatestCycle(input.activeSessionId)?.id).toBe(replacement.id);
		expect(replacement.nextRunAt).toBe("2026-01-01T00:05:00.000Z");

		const [dispatch] = store.claimDue(new Date("2026-01-01T00:05:00.000Z"));
		expect(dispatch?.job.nextRunAt).toBeUndefined();
		store.recordCycleRound(
			replacement.id,
			{ kind: "completed", usedTool: true, empty: false, response: "progress", reflection: false },
			new Date("2026-01-01T00:07:00.000Z"),
		);
		store.recordDispatchResult(dispatch!.id, {
			outcome: "ran",
			now: new Date("2026-01-01T00:07:00.000Z"),
		});

		expect(store.getCycle(input.activeSessionId)).toMatchObject({
			runCount: 1,
			nextRunAt: "2026-01-01T00:12:00.000Z",
			cycle: { rounds: 1, successfulRounds: 1, lastOutcome: "activity" },
		});
	});

	it("recovers an interrupted claimed round without replaying it immediately", () => {
		const store = createStore();
		const cycle = store.createCycle({
			...input,
			scheduleText: "every 30s",
			now: new Date("2026-01-01T00:00:00.000Z"),
		});
		store.claimDue(new Date("2026-01-01T00:00:30.000Z"));

		store.recoverInterruptedDispatches(new Date("2026-01-01T00:01:00.000Z"));

		expect(store.list().find((job) => job.id === cycle.id)).toMatchObject({
			status: "active",
			nextRunAt: "2026-01-01T00:01:30.000Z",
			lastError: "Interrupted before Cycle round completion",
			cycle: { rounds: 1, interruptedRounds: 1, lastOutcome: "interrupted" },
		});
	});

	it("re-arms the scheduler after a completion-anchored round", async () => {
		const store = createStore();
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		const completedAt = new Date("2026-01-01T00:00:40.000Z");
		store.createCycle({ ...input, scheduleText: "every 30s", now: startedAt });
		let clock = startedAt;
		const scheduler = new AgentCronScheduler(store, {
			now: () => clock,
			runJob: async () => {
				clock = completedAt;
				return undefined;
			},
		});
		const schedulerInternals = scheduler as unknown as { scheduleNext(delayMs?: number): void };
		const scheduleNext = vi.spyOn(schedulerInternals, "scheduleNext");
		scheduler.start();
		scheduleNext.mockClear();

		await scheduler.runDue(new Date("2026-01-01T00:00:30.000Z"));

		expect(scheduleNext).toHaveBeenCalledTimes(2);
		expect(store.getCycle(input.activeSessionId)?.nextRunAt).toBe("2026-01-01T00:01:10.000Z");
		scheduler.stop();
	});

	it("pauses on user intervention and resumes with a run due immediately", () => {
		const store = createStore();
		store.createCycle({ ...input, scheduleText: "every 5m", now: new Date("2026-01-01T00:00:00.000Z") });

		const paused = store.pauseCycleForUserIntervention(input.activeSessionId, new Date("2026-01-01T00:01:00.000Z"));
		expect(paused).toMatchObject({ status: "paused", cycle: { pauseReason: "user_intervention" } });
		expect(paused?.nextRunAt).toBeUndefined();

		const resumed = store.updateCycle(input.activeSessionId, "resume", new Date("2026-01-01T00:02:00.000Z"));
		expect(resumed).toMatchObject({ status: "active", nextRunAt: "2026-01-01T00:02:00.000Z" });
		expect(resumed?.cycle?.pauseReason).toBeUndefined();
	});
});

describe("Cycle round guardrails", () => {
	it("requests reflection after two dry rounds and pauses after a post-reflection dry round", () => {
		let state = createInitialAgentCycleState();
		for (const response of ["checking", "still checking"]) {
			state = advanceAgentCycle(state, {
				kind: "completed",
				usedTool: false,
				empty: false,
				response,
				reflection: false,
			}).cycle;
		}
		expect(isAgentCycleReflectionRound(state)).toBe(true);
		expect(
			createAgentCyclePrompt({ prompt: "continue", cycle: state, schedule: { expression: "every 5m" } }),
		).toContain("Reflection trigger");

		state = advanceAgentCycle(state, {
			kind: "completed",
			usedTool: false,
			empty: false,
			response: "reassessed",
			reflection: true,
		}).cycle;
		const afterReflection = advanceAgentCycle(state, {
			kind: "completed",
			usedTool: false,
			empty: false,
			response: "waiting",
			reflection: false,
		});
		expect(afterReflection).toMatchObject({
			status: "paused",
			cycle: { pauseReason: "post_reflection_dry" },
		});
	});

	it("stops after five failures or two empty provider responses", () => {
		let failures = createInitialAgentCycleState();
		let failureStatus: ReturnType<typeof advanceAgentCycle>["status"] = "active";
		for (let index = 0; index < 5; index++) {
			const next = advanceAgentCycle(failures, { kind: "failure", error: "mock failure", reflection: false });
			failures = next.cycle;
			failureStatus = next.status;
		}
		expect(failureStatus).toBe("cancelled");
		expect(failures.pauseReason).toBe("consecutive_failures");

		let empty = createInitialAgentCycleState();
		empty = advanceAgentCycle(empty, {
			kind: "completed",
			usedTool: false,
			empty: true,
			response: "",
			reflection: false,
		}).cycle;
		const stopped = advanceAgentCycle(empty, {
			kind: "completed",
			usedTool: false,
			empty: true,
			response: "",
			reflection: false,
		});
		expect(stopped).toMatchObject({ status: "cancelled", cycle: { pauseReason: "empty_response" } });
	});

	it("classifies mock assistant tool use, errors, and user intervention", () => {
		const toolRound = observeAgentCycleRound(
			[
				assistant([{ type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "1 + 1" } }]),
			] satisfies AgentMessage[],
			false,
		);
		expect(toolRound).toMatchObject({ kind: "completed", usedTool: true, empty: false });

		const failed = observeAgentCycleRound(
			[assistant([], "error", { output: 0, errorMessage: "mock provider failed" })],
			false,
		);
		expect(failed).toEqual({
			kind: "failure",
			error: "mock provider failed",
			reflection: false,
		});

		const interrupted = observeAgentCycleRound([{ role: "user", content: "redirect", timestamp: Date.now() }], false);
		expect(interrupted).toEqual({
			kind: "interrupted",
			reason: "user_intervention",
			reflection: false,
		});
	});
});
