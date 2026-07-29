/** Ceiling on a single tool's text response, to protect the agent's context. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Largest converted file returned inline as base64. Above this the caller is
 * pointed at the file on disk instead — base64 inflates by ~33% and a few MB of
 * it would swamp a model's context window.
 */
export const INLINE_RESULT_BYTE_LIMIT = 1024 * 1024;

export const SERVER_NAME = "convertx-mcp-server";
export const SERVER_VERSION = "1.0.0";
