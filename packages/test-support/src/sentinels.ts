/**
 * A recognizable value used to prove that secret material never reaches logs, responses, or
 * build artifacts.
 *
 * Tests may embed this value in fixtures. Any occurrence in output is a defect.
 */
export const SENTINEL_VALUE = "SENTINEL_DO_NOT_LEAK_7f3a";

/**
 * A recognizable secret key name used alongside {@link SENTINEL_VALUE}.
 *
 * The key itself is not sensitive, but it makes sentinel-bearing fixtures easy to find and
 * easy to scan for in build output.
 */
export const SENTINEL_KEY = "SENTINEL_KEY_DO_NOT_LEAK_7f3a";
