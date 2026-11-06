const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** 把毫秒格式化成折叠头用的简短耗时文案，例如 `26s`、`4m 26s`、`1h 5m`。 */
export function formatDuration(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / MS_PER_SECOND));
	if (totalSeconds < SECONDS_PER_MINUTE) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;
	if (totalMinutes < MINUTES_PER_HOUR) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
	const minutes = totalMinutes % MINUTES_PER_HOUR;
	return `${hours}h ${minutes}m`;
}
