/** Stable gateway failures reported after HTTP headers have already committed. */
export const GATEWAY_TRANSIENT_PATTERN =
	/\b(?:upstream_stream_(?:read_error|truncated)|upstream_ws_failover_exhausted|gateway_queue_full|gateway_concurrency_limit|openai_silent_refusal)\b|\bNo available accounts(?=$|\s+\()|\bUpstream returned an empty completion without usage; no fallback account was available\b/i;

/** A gateway's upstream credentials need operator attention, even behind HTTP 502. */
export const GATEWAY_CREDENTIAL_FAILURE_PATTERN =
	/\bUpstream (?:authentication failed|access forbidden), please contact administrator\b/i;
