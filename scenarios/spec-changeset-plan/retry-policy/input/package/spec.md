# retry-policy

Implement retryDelay(attempt,{baseMs=100,capMs=10000,retryAfterMs=null}={}). attempt must be a nonnegative safe integer; baseMs and capMs must be nonnegative finite numbers; retryAfterMs must be null or a nonnegative finite number. Invalid inputs throw RangeError. Return min(capMs, max(baseMs*2**attempt,retryAfterMs ?? 0)). Avoid NaN for baseMs=0 and huge attempts: exponential delay is always zero in that case. Huge positive exponential delay saturates at capMs.
Implement statusLabel(status): integer 200..299 -> "success", 429 -> "rate-limited", integer 500..599 -> "retryable", all other values including strings/fractions -> "terminal".
Enable config retry and preserve keep. Execution classification: retry involved, status simple, config deterministic. Keep unrelated files unchanged.
