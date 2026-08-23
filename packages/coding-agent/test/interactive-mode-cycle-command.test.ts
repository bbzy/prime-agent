import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import { createInitialAgentCycleState } from "../src/core/cycle.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface CycleCommandConnection {
	supportsCycleAutomation(): boolean;
	getCycle(): Promise<AgentCronJob | undefined>;
	setCycle(schedule: string): Promise<AgentCronJob>;
	updateCycle(action: "pause" | "resume" | "run" | "stop"): Promise<AgentCronJob | undefined>;
}

interface CycleCommandThis {
	agentConnection: CycleCommandConnection;
	showStatus(message: string): void;
	showError(message: string): void;
}

type InteractiveModePrototype = {
	getCycleArgumentCompletions(prefix: string): AutocompleteItem[] | null;
	handleCycleCommand(this: CycleCommandThis, text: string): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

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
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
		cycle: createInitialAgentCycleState(new Date("2026-01-01T00:00:00.000Z")),
	};
}

describe("InteractiveMode /cycle", () => {
	it("offers lifecycle argument completions", () => {
		expect(prototype.getCycleArgumentCompletions("")?.map((item) => item.label)).toEqual([
			"start <interval>",
			"status",
			"pause",
			"resume",
			"run",
			"stop",
		]);
		expect(prototype.getCycleArgumentCompletions("res")?.map((item) => item.label)).toEqual(["resume"]);
	});

	it("starts Cycle through the capability-gated daemon connection", async () => {
		const setCycle = vi.fn(async () => cycleJob());
		const showStatus = vi.fn();
		const showError = vi.fn();
		const fakeThis: CycleCommandThis = {
			agentConnection: {
				supportsCycleAutomation: () => true,
				getCycle: async () => undefined,
				setCycle,
				updateCycle: async () => undefined,
			},
			showStatus,
			showError,
		};

		await prototype.handleCycleCommand.call(fakeThis, "/cycle 5m");

		expect(setCycle).toHaveBeenCalledWith("every 5m");
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Cycle started: 5m"));
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not send Cycle commands from a new client to an unsupported old daemon", async () => {
		const setCycle = vi.fn(async () => cycleJob());
		const showError = vi.fn();
		const fakeThis: CycleCommandThis = {
			agentConnection: {
				supportsCycleAutomation: () => false,
				getCycle: async () => undefined,
				setCycle,
				updateCycle: async () => undefined,
			},
			showStatus: vi.fn(),
			showError,
		};

		await prototype.handleCycleCommand.call(fakeThis, "/cycle 5m");

		expect(setCycle).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(expect.stringContaining("newer Prime Agent daemon"));
	});
});
