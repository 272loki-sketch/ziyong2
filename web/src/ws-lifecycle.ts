/**
 * WS 重连辅助：只放纯规则，便于 node 单测钉死生命周期边界。
 */

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export const WS_RETRY_INITIAL_MS = 1500;
export const WS_RETRY_MAX_MS = 10_000;

export function buildWireUrl(protocol: string, host: string): string {
	const wsProto = protocol === "https:" ? "wss:" : "ws:";
	return `${wsProto}//${host}/ws`;
}

export function canOpenWire(readyState: number | null | undefined): boolean {
	return readyState == null || readyState === WS_CLOSED;
}

export function nextRetryMs(retryMs: number): number {
	return Math.min(retryMs * 2, WS_RETRY_MAX_MS);
}

export function shouldWakeFromVisibility(
	visibilityState: string,
	closed: boolean,
	readyState: number | null | undefined,
): boolean {
	return visibilityState === "visible" && !closed && canOpenWire(readyState);
}

export function shouldWakeFromOnline(closed: boolean, readyState: number | null | undefined): boolean {
	return !closed && canOpenWire(readyState);
}
