import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { type AgentCycleRoundObservation, createInitialAgentCycleState } from "../src/core/cycle.js";
import { createHeartbeatPromptMessage } from "../src/core/messages.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

interface FakeSession {
	messages: AgentMessage[];
	waitForIdle(): Promise<void>;
}

interface FakeState {
	activeSessionId: string;
	runtime: { session: FakeSession };
}

interface FakeCycleDaemon {
	cronStore: {
		recordCycleRound(id: string, observation: AgentCycleRoundObservation): AgentCronJob | undefined;
	};
	getRunnableCronJob(id: string): AgentCronJob | undefined;
	isCronJobRunnableForState(job: AgentCronJob, state: FakeState, requirePersistedJob: boolean): boolean;
	promptHeartbeatWithAgentMessagePreparingGuard(
		state: FakeState,
		job: AgentCronJob,
		options: unknown,
		getPromptJob?: () => AgentCronJob | undefined,
	): Promise<boolean>;
}

type AgentDaemonPrototype = {
	runCycleJob(
		this: FakeCycleDaemon,
		state: FakeState,
		job: AgentCronJob,
		requirePersistedJob: boolean,
	): Promise<"skipped" | undefined>;
	handleCommand(
		this: object,
		client: object,
		command: { id: string; type: string; [key: string]: unknown },
	): Promise<unknown>;
};

const prototype = AgentDaemon.prototype as unknown as AgentDaemonPrototype;

function cycleJob(): AgentCronJob {
	return {
		id: "cycle-1",
		status: "active",
		source: "cycle",
		runtimeKind: "top-level",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		prompt: "Continue owning and advancing the current task.",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		runCount: 0,
		cycle: createInitialAgentCycleState(new Date("2026-01-01T00:00:00.000Z")),
	};
}

function toolAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "1 + 1" } }],
		api: "mock-api",
		provider: "mock-provider",
		model: "mock-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("AgentDaemon Cycle dispatch", () => {
	it("keeps Cycle state out of the legacy cron list for old clients", async () => {
		const cycle = cycleJob();
		const cron: AgentCronJob = { ...cycle, id: "cron-1", source: "cron", cycle: undefined };
		const response = await prototype.handleCommand.call(
			{ cronStore: { list: () => [cycle, cron] } },
			{},
			{ id: "cron-list-1", type: "cron_list", includeInactive: true },
		);

		expect(response).toMatchObject({
			success: true,
			command: "cron_list",
			data: { jobs: [{ id: "cron-1" }] },
		});
	});

	it("pauses an active Cycle when the user steers the session", async () => {
		const pauseCycleForUserIntervention = vi.fn();
		const steer = vi.fn(async () => undefined);
		const state = { runtime: { session: { steer } } };
		const fakeDaemon = {
			getBoundSessionState: () => state,
			pauseCycleForUserIntervention,
			recordWorkerRecoveryState: vi.fn(),
		};

		await prototype.handleCommand.call(
			fakeDaemon,
			{},
			{
				id: "steer-1",
				type: "steer",
				activeSessionId: "active-1",
				message: "take a different direction",
			},
		);

		expect(pauseCycleForUserIntervention).toHaveBeenCalledWith(state);
		expect(steer).toHaveBeenCalledWith("take a different direction", undefined, {
			queueKey: undefined,
			agentMessageId: undefined,
			resumeIfIdle: true,
		});
	});

	it("waits for idle, injects the owner prompt, and records mock tool activity", async () => {
		const job = cycleJob();
		const order: string[] = [];
		const session: FakeSession = {
			messages: [],
			waitForIdle: async () => {
				order.push("idle");
			},
		};
		const state: FakeState = { activeSessionId: "active-1", runtime: { session } };
		const recordCycleRound = vi.fn(() => job);
		const fakeDaemon: FakeCycleDaemon = {
			cronStore: { recordCycleRound },
			getRunnableCronJob: () => job,
			isCronJobRunnableForState: () => true,
			promptHeartbeatWithAgentMessagePreparingGuard: async (_state, promptJob, _options, getPromptJob) => {
				order.push("prompt");
				const checked = getPromptJob?.() ?? promptJob;
				expect(checked.prompt).toContain("[Cycle #1]");
				expect(checked.prompt).toContain("cycle-owner");
				session.messages.push(createHeartbeatPromptMessage(checked), toolAssistant());
				return true;
			},
		};

		await prototype.runCycleJob.call(fakeDaemon, state, job, true);

		expect(order).toEqual(["idle", "prompt"]);
		expect(recordCycleRound).toHaveBeenCalledWith(
			job.id,
			expect.objectContaining({ kind: "completed", usedTool: true, empty: false }),
		);
	});

	it("does not inject a round after the persisted Cycle is paused while waiting", async () => {
		const job = cycleJob();
		const prompt = vi.fn(async () => true);
		const state: FakeState = {
			activeSessionId: "active-1",
			runtime: { session: { messages: [], waitForIdle: async () => undefined } },
		};
		const fakeDaemon: FakeCycleDaemon = {
			cronStore: { recordCycleRound: () => undefined },
			getRunnableCronJob: () => undefined,
			isCronJobRunnableForState: () => false,
			promptHeartbeatWithAgentMessagePreparingGuard: prompt,
		};

		await expect(prototype.runCycleJob.call(fakeDaemon, state, job, true)).resolves.toBe("skipped");
		expect(prompt).not.toHaveBeenCalled();
	});
});
