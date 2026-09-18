/**
 * WS 客户端：同源 /ws，断线自动重连（1.5s 起指数退避，封顶 10s）。
 * 只负责连接与帧收发，状态归 App。
 */

import { useEffect, useRef } from "react";
import {
	buildWireUrl,
	nextRetryMs,
	shouldWakeFromOnline,
	shouldWakeFromVisibility,
	WS_RETRY_INITIAL_MS,
} from "./ws-lifecycle.ts";
import type { ClientFrame, ServerFrame } from "./wire.ts";

export type ConnState = "connecting" | "open" | "closed";

export interface WsHandle {
	send: (frame: ClientFrame) => void;
}


export function useWire(onFrame: (frame: ServerFrame) => void, onState: (s: ConnState) => void): WsHandle {
	const wsRef = useRef<WebSocket | null>(null);
	const onFrameRef = useRef(onFrame);
	const onStateRef = useRef(onState);
	onFrameRef.current = onFrame;
	onStateRef.current = onState;

	useEffect(() => {
		let closed = false;
		let retryMs = WS_RETRY_INITIAL_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const clearRetryTimer = () => {
			if (!timer) return;
			clearTimeout(timer);
			timer = undefined;
		};

		const connect = () => {
			clearRetryTimer();
			const current = wsRef.current;
			if (closed) return;
			if (current && current.readyState !== WebSocket.CLOSED) return;
			onStateRef.current("connecting");
			const ws = new WebSocket(buildWireUrl(location.protocol, location.host));
			wsRef.current = ws;

			ws.onopen = () => {
				if (closed || wsRef.current !== ws) return;
				retryMs = WS_RETRY_INITIAL_MS;
				onStateRef.current("open");
			};
			ws.onmessage = (ev) => {
				if (wsRef.current !== ws) return;
				try {
					onFrameRef.current(JSON.parse(String(ev.data)) as ServerFrame);
				} catch {
					// 非 JSON 帧忽略
				}
			};
			ws.onclose = (ev) => {
				const isCurrent = wsRef.current === ws;
				if (isCurrent) wsRef.current = null;
				if (closed || !isCurrent) return;
				// 4401 = 服务端鉴权失败（密码在别处被改）：刷新回登录门，别在这无谓重连
				if (ev.code === 4401) {
					location.reload();
					return;
				}
				onStateRef.current("closed");
				timer = setTimeout(connect, retryMs);
				retryMs = nextRetryMs(retryMs);
			};
			ws.onerror = () => {
				if (wsRef.current !== ws) return;
				ws.close();
			};
		};

		const wakeReconnect = () => {
			clearRetryTimer();
			connect();
		};

		const onVisibilityChange = () => {
			if (!shouldWakeFromVisibility(document.visibilityState, closed, wsRef.current?.readyState)) return;
			wakeReconnect();
		};

		const onOnline = () => {
			if (!shouldWakeFromOnline(closed, wsRef.current?.readyState)) return;
			wakeReconnect();
		};

		connect();
		window.addEventListener("online", onOnline);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			closed = true;
			clearRetryTimer();
			window.removeEventListener("online", onOnline);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			const ws = wsRef.current;
			wsRef.current = null;
			ws?.close();
		};
	}, []);

	return {
		send: (frame) => {
			const ws = wsRef.current;
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
		},
	};
}
