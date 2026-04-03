type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

const LEVEL_ORDER: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];

function levelValue(l: LogLevel): number {
	return LEVEL_ORDER.indexOf(l);
}

class SimpleLogger {
	level: LogLevel = "info";

	private shouldLog(l: LogLevel): boolean {
		return levelValue(l) >= levelValue(this.level);
	}

	trace(msgOrObj: unknown, msg?: string) { if (this.shouldLog("trace")) this.write("TRACE", msgOrObj, msg); }
	debug(msgOrObj: unknown, msg?: string) { if (this.shouldLog("debug")) this.write("DEBUG", msgOrObj, msg); }
	info(msgOrObj: unknown, msg?: string)  { if (this.shouldLog("info"))  this.write("INFO",  msgOrObj, msg); }
	warn(msgOrObj: unknown, msg?: string)  { if (this.shouldLog("warn"))  this.write("WARN",  msgOrObj, msg); }
	error(msgOrObj: unknown, msg?: string) { if (this.shouldLog("error")) this.write("ERROR", msgOrObj, msg); }
	fatal(msgOrObj: unknown, msg?: string) { if (this.shouldLog("fatal")) this.write("FATAL", msgOrObj, msg); }

	private write(level: string, first: unknown, second?: string) {
		const ts = new Date().toISOString();
		if (typeof first === "string" && second === undefined) {
			console.log(`[${ts}] ${level} ${first}`);
		} else if (second !== undefined) {
			console.log(`[${ts}] ${level} ${second}`, typeof first === "object" ? JSON.stringify(first) : first);
		} else {
			console.log(`[${ts}] ${level}`, typeof first === "object" ? JSON.stringify(first) : first);
		}
	}
}

export const logger = new SimpleLogger();

export function applyLogLevelFromConfig(configLogLevel?: string): void {
	const level =
		process.env.LOG_LEVEL ??
		configLogLevel ??
		(process.env.NODE_ENV === "production" ? "info" : "debug");
	logger.level = level as LogLevel;
}
